import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";

// ==========================================
// CONFIGURATION
// ==========================================

const DISPLAY_WIDTH = 576;
const DISPLAY_HEIGHT = 288;

const TARGET_WIDTH = 32;
const TARGET_HEIGHT = 32;

const STORAGE_KEY = "g2_experiment_backup_v2";

interface Trial {
  trial: number;
  x: number;
  y: number;
  status: string;

  onsetRequestISO: string;
  onsetRequestMs: number;
  onsetAckMs: number | null;
  onsetResult: string;

  offsetRequestISO: string | null;
  offsetRequestMs: number | null;
  offsetAckMs: number | null;
  offsetResult: string;

  error: string;
}

interface Settings {
  duration: number;
  interval: number;
  trials: number;
}

let bridge: Awaited<
  ReturnType<typeof waitForEvenAppBridge>
>;

let running = false;
let stopRequested = false;

let records: Trial[] = [];
let sessionId = "";

let uploadQueue: Promise<void> = Promise.resolve();
let uploadError = "";

// ==========================================
// USER INTERFACE
// ==========================================

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="experiment">
    <h1>G2 Target Calibration</h1>

    <p id="status">Connecting to glasses...</p>

    <label>
      Target duration (milliseconds)
      <input id="duration" type="number"
             value="1000" min="100" step="100">
    </label>

    <label>
      Blank interval (milliseconds)
      <input id="interval" type="number"
             value="500" min="0" step="100">
    </label>

    <label>
      Number of trials
      <input id="trials" type="number"
             value="50" min="1" max="10000">
    </label>

    <div class="buttons">
      <button id="start" disabled>
        Start Calibration
      </button>

      <button id="stop" disabled>
        Stop
      </button>

      <button id="save">
        Retry PC Save
      </button>

      <button id="export">
        Export CSV Backup
      </button>
    </div>

    <h2 id="progress">Trial: 0 / 0</h2>

    <p id="position">Position: --</p>
    <p id="latency">SDK update time: --</p>
    <p id="saved">PC save: waiting</p>
  </div>
`;

const style = document.createElement("style");

style.textContent = `
  body {
    font-family: system-ui, sans-serif;
    background: #101614;
    color: #f0f5f1;
    margin: 0;
    padding: 20px;
  }

  .experiment {
    max-width: 480px;
    margin: auto;
  }

  h1 {
    font-size: 24px;
  }

  label {
    display: block;
    margin: 18px 0;
    font-size: 14px;
  }

  input {
    display: block;
    box-sizing: border-box;
    width: 100%;
    padding: 12px;
    margin-top: 6px;
    font-size: 18px;
    border-radius: 8px;
    border: 1px solid #52645b;
    background: #1c2922;
    color: white;
  }

  button {
    padding: 14px;
    border: 0;
    border-radius: 8px;
    background: #64d89b;
    color: #102017;
    font-size: 15px;
    font-weight: bold;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.4;
  }

  .buttons {
    display: grid;
    gap: 10px;
    margin: 24px 0;
  }

  #status {
    color: #8de9b1;
  }
`;

document.head.appendChild(style);

function setText(id: string, value: string) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setRunningUI(active: boolean) {
  (
    document.getElementById("start") as HTMLButtonElement
  ).disabled = active;

  (
    document.getElementById("stop") as HTMLButtonElement
  ).disabled = !active;

  for (const id of ["duration", "interval", "trials"]) {
    (
      document.getElementById(id) as HTMLInputElement
    ).disabled = active;
  }
}

function readSettings(): Settings {
  const read = (id: string) =>
    Number(
      (document.getElementById(id) as HTMLInputElement).value
    );

  const settings = {
    duration: read("duration"),
    interval: read("interval"),
    trials: read("trials"),
  };

  if (
    !Number.isInteger(settings.duration) ||
    settings.duration < 100 ||
    !Number.isInteger(settings.interval) ||
    settings.interval < 0 ||
    !Number.isInteger(settings.trials) ||
    settings.trials < 1 ||
    settings.trials > 10000
  ) {
    throw new Error("Invalid calibration settings");
  }

  return settings;
}

// ==========================================
// RANDOM TARGET POSITIONS
// ==========================================

function randomPosition() {
  return {
    x: Math.floor(
      Math.random() * (DISPLAY_WIDTH - TARGET_WIDTH + 1)
    ),
    y: Math.floor(
      Math.random() * (DISPLAY_HEIGHT - TARGET_HEIGHT + 1)
    ),
  };
}

// ==========================================
// GLASSES DISPLAY
// ==========================================

function targetContainer(
  x: number,
  y: number,
  visible: boolean
) {
  return {
    xPosition: x,
    yPosition: y,
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    containerID: 1,
    containerName: "target",
    content: visible ? "+" : "",
    isEventCapture: 1,
  };
}

async function updateTarget(
  x: number,
  y: number,
  visible: boolean
) {
  const requestedMs = performance.now();
  const requestedISO = new Date().toISOString();

  const result = await bridge.rebuildPageContainer({
    containerTotalNum: 1,
    textObject: [
      targetContainer(x, y, visible)
    ],
  });

  const acknowledgedMs = performance.now();

  if (result === false) {
    throw new Error("rebuildPageContainer returned false");
  }

  return {
    requestedMs,
    requestedISO,
    acknowledgedMs,
    result: String(result),
  };
}

// ==========================================
// AUTOMATIC PC SAVING
// ==========================================

function saveLocalBackup() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessionId,
        records,
      })
    );
  } catch (error) {
    console.error("Local backup failed:", error);
  }
}

function restoreLocalBackup() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const saved = JSON.parse(raw);

    if (Array.isArray(saved.records)) {
      records = saved.records;
      sessionId = saved.sessionId ?? "";

      setText(
        "saved",
        `Recovered ${records.length} local trial records`
      );
    }
  } catch (error) {
    console.error("Restore failed:", error);
  }
}

function uploadRecords() {
  if (!sessionId || records.length === 0) return;

  // Capture the data immediately so each upload
  // contains a consistent snapshot.
  const snapshot = JSON.stringify({
    sessionId,
    records,
  });

  uploadQueue = uploadQueue
    .catch(() => {})
    .then(async () => {
      const response = await fetch("/api/save-trials", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: snapshot,
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const result = await response.json();

      uploadError = "";

      setText(
        "saved",
        `Saved to PC: ${result.count} trials`
      );
    })
    .catch(error => {
      uploadError = String(error);

      console.error("PC save failed:", error);

      setText(
        "saved",
        "PC save failed - local backup retained"
      );
    });
}

function saveRecords() {
  saveLocalBackup();
  uploadRecords();
}

// ==========================================
// EXPERIMENT TIMING
// ==========================================

async function waitUntil(deadlineMs: number) {
  while (!stopRequested) {
    const remaining = deadlineMs - performance.now();

    if (remaining <= 0) break;

    await new Promise<void>(resolve =>
      setTimeout(resolve, Math.min(remaining, 50))
    );
  }
}

async function startExperiment() {
  if (running) return;

  let settings: Settings;

  try {
    settings = readSettings();
  } catch (error) {
    setText("status", String(error));
    return;
  }

  // Ensure the previous session's queued uploads
  // finish before beginning a new session.
  await uploadQueue;

  running = true;
  stopRequested = false;
  uploadError = "";

  records = [];
  // crypto.randomUUID only exists on https/localhost,
  // not on the phone's http://<LAN IP> page.
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  setRunningUI(true);
  setText("status", "Calibration running...");

  let lastX = 0;
  let lastY = 0;

  try {
    for (let i = 0; i < settings.trials; i++) {
      if (stopRequested) break;

      const { x, y } = randomPosition();

      lastX = x;
      lastY = y;

      const trial: Trial = {
        trial: i + 1,
        x,
        y,
        status: "started",

        onsetRequestISO: "",
        onsetRequestMs: 0,
        onsetAckMs: null,
        onsetResult: "",

        offsetRequestISO: null,
        offsetRequestMs: null,
        offsetAckMs: null,
        offsetResult: "",

        error: "",
      };

      records.push(trial);

      setText(
        "progress",
        `Trial: ${i + 1} / ${settings.trials}`
      );

      setText(
        "position",
        `Position: (${x}, ${y})`
      );

      try {
        // ------------------------------
        // PRESENT TARGET
        // ------------------------------

        const onset = await updateTarget(x, y, true);

        trial.onsetRequestISO = onset.requestedISO;
        trial.onsetRequestMs = onset.requestedMs;
        trial.onsetAckMs = onset.acknowledgedMs;
        trial.onsetResult = onset.result;
        trial.status = "onset_acknowledged";

        setText(
          "latency",
          `SDK update time: ${(
            onset.acknowledgedMs - onset.requestedMs
          ).toFixed(2)} ms`
        );

        saveRecords();

        // Wait from the end of the SDK call.
        await waitUntil(
          onset.acknowledgedMs + settings.duration
        );

        // ------------------------------
        // REMOVE TARGET
        // ------------------------------

        const offset = await updateTarget(x, y, false);

        trial.offsetRequestISO = offset.requestedISO;
        trial.offsetRequestMs = offset.requestedMs;
        trial.offsetAckMs = offset.acknowledgedMs;
        trial.offsetResult = offset.result;

        trial.status = stopRequested
          ? "stopped"
          : "complete";

        saveRecords();

        if (stopRequested) break;

        // ------------------------------
        // BLANK INTERVAL
        // ------------------------------

        await waitUntil(
          offset.acknowledgedMs + settings.interval
        );

      } catch (error) {
        trial.status = "error";
        trial.error = String(error);

        saveRecords();
        throw error;
      }
    }

    setText(
      "status",
      stopRequested
        ? "Calibration stopped"
        : "Calibration complete"
    );

  } catch (error) {
    console.error("Calibration error:", error);

    setText(
      "status",
      `Calibration error: ${String(error)}`
    );

    // Attempt to clear the target.
    try {
      await updateTarget(lastX, lastY, false);
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError);
    }

  } finally {
    // Save the final state and wait for all
    // pending network uploads to finish.
    saveRecords();

    await uploadQueue;

    running = false;
    setRunningUI(false);

    const current =
      document.getElementById("status")?.textContent ?? "";

    setText(
      "status",
      `${current} - ${
        uploadError ? "PC save failed" : "CSV saved to PC"
      }`
    );
  }
}

// ==========================================
// CSV BACKUP EXPORT
// ==========================================

function exportCSV() {
  if (records.length === 0) {
    setText("status", "No trials to export");
    return;
  }

  const columns = [
    "session_id",
    "trial",
    "x",
    "y",
    "status",
    "onset_request_iso",
    "onset_request_ms",
    "onset_ack_ms",
    "onset_sdk_duration_ms",
    "offset_request_iso",
    "offset_request_ms",
    "offset_ack_ms",
    "offset_sdk_duration_ms",
    "ack_to_offset_request_ms",
    "onset_result",
    "offset_result",
    "error",
  ];

  const rows = records.map(t => [
    sessionId,
    t.trial,
    t.x,
    t.y,
    t.status,
    t.onsetRequestISO,
    t.onsetRequestMs,
    t.onsetAckMs ?? "",
    t.onsetAckMs === null
      ? ""
      : t.onsetAckMs - t.onsetRequestMs,
    t.offsetRequestISO ?? "",
    t.offsetRequestMs ?? "",
    t.offsetAckMs ?? "",
    t.offsetAckMs === null || t.offsetRequestMs === null
      ? ""
      : t.offsetAckMs - t.offsetRequestMs,
    t.onsetAckMs === null || t.offsetRequestMs === null
      ? ""
      : t.offsetRequestMs - t.onsetAckMs,
    t.onsetResult,
    t.offsetResult,
    t.error,
  ]);

  const escapeCSV = (value: unknown) =>
    `"${String(value).replace(/"/g, '""')}"`;

  const csv = [columns, ...rows]
    .map(row => row.map(escapeCSV).join(","))
    .join("\r\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `g2_targets_${Date.now()}.csv`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==========================================
// INITIALIZE G2 CONNECTION
// ==========================================

async function initialize() {
  restoreLocalBackup();

  document.getElementById("save")!
    .addEventListener("click", () => {
      uploadRecords();
    });

  document.getElementById("export")!
    .addEventListener("click", exportCSV);

  setText("status", "Waiting for Even app bridge...");

  bridge = await waitForEvenAppBridge();

  setText("status", "Bridge found - creating glasses page...");

  // Same startup structure as the successful test.
  const result = await bridge.createStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [
      targetContainer(0, 0, false)
    ],
  });

  console.log("G2 startup result:", result);

  // 0 = success, 1 = invalid, 2 = oversize, 3 = outOfMemory.
  // On a reload the startup page usually already exists and
  // create returns 1, so fall back to rebuilding it.
  if (Number(result) !== 0) {
    const rebuilt = await bridge.rebuildPageContainer({
      containerTotalNum: 1,
      textObject: [targetContainer(0, 0, false)],
    });

    console.log("G2 rebuild fallback result:", rebuilt);

    if (!rebuilt) {
      // Not fatal: earlier runs never checked this and
      // trials still updated the glasses fine.
      setText(
        "status",
        `Connected - startup not confirmed (create ${result}, rebuild ${rebuilt}). Try Start.`
      );
    } else {
      setText("status", "Connected - Ready");
    }
  } else {
    setText("status", "Connected - Ready");
  }

  (
    document.getElementById("start") as HTMLButtonElement
  ).disabled = false;

  document.getElementById("start")!
    .addEventListener("click", () => {
      startExperiment().catch(error => {
        console.error(error);
        running = false;
        setRunningUI(false);
        setText("status", `Start failed: ${String(error)}`);
      });
    });

  document.getElementById("stop")!
    .addEventListener("click", () => {
      stopRequested = true;
      setText("status", "Stopping...");
    });

}

initialize().catch(error => {
  console.error(error);

  setText(
    "status",
    `Connection error: ${String(error)}`
  );
});