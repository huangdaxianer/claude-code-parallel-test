const { exec } = require('child_process');

const PID = process.argv[2];
if (!PID) {
    console.error("Usage: node debug_detection.js <PID>");
    process.exit(1);
}

function getChildPids(pid) {
    return new Promise((resolve) => {
        exec(`pgrep -P ${pid}`, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            const pids = stdout.trim().split(/\s+/).map(p => parseInt(p, 10));
            Promise.all(pids.map(getChildPids)).then(grandChildren => {
                const all = [...pids, ...grandChildren.flat()];
                resolve(all);
            });
        });
    });
}

function getListeningPorts(pids) {
    if (pids.length === 0) return Promise.resolve([]);
    const pidList = pids.join(',');
    console.log(`Scanning ports for PIDs: ${pidList}`);
    return new Promise((resolve) => {
        exec(`lsof -a -iTCP -sTCP:LISTEN -p ${pidList} -n -P -Fn`, (err, stdout) => {
            if (err) {
                console.error("lsof error:", err.message);
                // Try without -p to see if permission issue for some?
                // But sticking to logic in server.js
                return resolve([]);
            }
            if (!stdout) return resolve([]);

            console.log("lsof raw output:\n" + stdout);

            const ports = new Set();
            stdout.split('\n').forEach(line => {
                if (line.startsWith('n')) {
                    const part = line.substring(1);
                    const portMatch = part.match(/:(\d+)$/);
                    if (portMatch) ports.add(parseInt(portMatch[1], 10));
                }
            });
            resolve(Array.from(ports));
        });
    });
}

(async () => {
    console.log(`Analyzing process tree for PID ${PID}...`);
    const children = [parseInt(PID), ...(await getChildPids(PID))];
    console.log("Found PIDs:", children);

    const ports = await getListeningPorts(children);
    console.log("Found Ports:", ports);
})();
