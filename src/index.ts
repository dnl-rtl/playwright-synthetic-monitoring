import express from "express";
import * as fs from "fs";
import { ChildProcess, exec } from "node:child_process";
import { statSync } from "node:fs";
import copy from "recursive-copy";
import { env } from "./EnvironmentVariable";

// Let's start an express server.
// This server will respond on the /healthcheck and the /metrics route with the status of the last page loading of Pupetteer

const app = express();

let status: "not-run" | "ok" | "ko" = "not-run";
let testDuration = 0;

app.get('/healthcheck', async (req, res) => {
    if (status === 'ko') {
        res.status(500);
        res.send(status);
    } else {
        res.status(200);
        res.send(status);
    }
});

app.get('/metrics', async (req, res) => {
    // Output the test duration in seconds and the status
    res.status(200);
    res.set('Content-Type', 'text/plain');
    const metrics = `# HELP playwright_synthetic_monitoring_test_duration_seconds Duration of the last test in seconds
# TYPE playwright_synthetic_monitoring_test_duration_seconds gauge
playwright_synthetic_monitoring_test_duration_seconds ${testDuration / 1000}
# HELP playwright_synthetic_monitoring_status Status of the last test
# TYPE playwright_synthetic_monitoring_status gauge
playwright_synthetic_monitoring_status ${status === 'ok' ? 1 : 0}`
    res.send(metrics);

});

// Generate an HTML status page with links to the "/healthcheck", "/metrics" and "/last-error" routes
// The status page will have a green badge if status if ok, a red badge if status is ko.
// It will also display the last test duration and the last date of failure.
app.get('/', (req, res) => {
    // Let's check the last modification date of the /last-error/index.html file
    // (if it exists)
    // This will give us the last test failure date
    // If the file does not exist, we will consider that the tests never failed
    let lastErrorDate = "Never";
    let hasLastError = false;
    try {
        const stats = statSync('last-error/index.html');
        lastErrorDate = stats.mtime.toLocaleString();
        hasLastError = true;
    } catch (e) {
        // Do nothing
    }

    let statusText: string = "";
    switch (status) {
        case "ok":
            statusText = "OK";
            break;
        case "ko":
            statusText = "KO";
            break;
        case "not-run":
            statusText = "Not run yet";
            break;
        default:
            const never: never = status;
    }

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #f4f4f4; }
        h1 { color: #333; }
        p, a, li { font-size: 16px; color: #444; }
        a { text-decoration: none; color: #007bff; }
        a:hover { text-decoration: underline; }
        .status-badge { padding: 5px 10px; color: #fff; border-radius: 5px; }
        .ok { background-color: #4CAF50; }
        .ko { background-color: #f44336; }
        .not-run { background-color: #999999; }
    </style>
    <title>Playwright Synthetic Monitoring</title>
</head>
<body>
    <h1>Playwright Synthetic Monitoring</h1>
    <p>Current status: <span class="status-badge ${status}">${statusText}</span></p>
    <p>Last test duration: ${testDuration / 1000} seconds</p>
    <p>Last error date: ${lastErrorDate} ${hasLastError ? `<a href="/last-error">(view last error report)</a>` : ""}</p>
    <ul>
        <li>
            <a href="/healthcheck">Healthcheck</a>: use this link to track the status of the test in a monitoring tool like UptimeRobot.
        </li>
        <li>
            <a href="/metrics">Metrics</a>: Prometheus probe to get the status of the last test and its duration.
        </li>
    </ul>
</body>
</html>
    `
    res.send(html);
});

app.use("/last-error", express.static('last-error'));

app.listen(3000, () => {
    console.log('Server listening on port 3000');
});

let childProcess: ChildProcess | undefined = undefined;

test().catch(e => console.error(e));
setInterval(() => {
    test().catch(e => console.error(e));
}, env.MONITORING_INTERVAL * 1000);

async function test() {
    if (childProcess) {
        console.log("Killing process that did not finish in time");
        childProcess.kill();
        childProcess = undefined;
    }
    const startTime = Date.now();
    childProcess = exec("npm run test", (error, stdout, stderr) => {
        testDuration = Date.now() - startTime;
        if (stdout) {
            console.log(stdout);
        }
        if (stderr) {
            console.log(stderr);
        }
        if (error) {
            console.error("Error code received: " + error.code);
            status = 'ko';
            // Let's copy the content of the playwright-report in the "last-error" directory.
            copy('playwright-report', 'last-error', { overwrite: true, dot: true }).then((result) => {
                // TODO: listen to events
                console.log("Report copied to 'last-error' directory");

                if (env.PERSIST_TRACE_DIRECTORY) {

                    // Get dynamic path
                    let files = [];
                    const resultsPath = "test-results"
                    try {
                        files = fs.readdirSync(resultsPath);
                    } catch (err) {
                        console.error(`Error reading directory: ${resultsPath}`, err);
                        throw err;
                    }

                    // Create dir, if not exists.
                    try {
                        fs.mkdirSync(env.PERSIST_TRACE_DIRECTORY);
                    } catch (error: any) {
                        if (error["code"].includes("EXIST")) console.log("Persistence trace dir already exists.");
                        else throw error;
                    }

                    // Get source dir
                    const _file = files.filter(file => !file.startsWith("."))[0];

                    const source = `test-results/${_file}/trace.zip`;
                    const destination = `${env.PERSIST_TRACE_DIRECTORY}/${new Date().toISOString()}.zip`;

                    // Copy trace
                    fs.copyFile(source, destination, fs.constants.COPYFILE_FICLONE, (error) => {
                        if (error) console.error(error);
                        else console.info(`Trace copied to:  ` + destination);
                    });
                }
            });


        } else {
            status = 'ok';
        }
        childProcess = undefined;
    });
}
