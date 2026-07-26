const form = document.getElementById("converter-form");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const fileList = document.getElementById("file-list");
const fileCount = document.getElementById("file-count");
const estimatedSize = document.getElementById("estimated-size");
const capacityBar = document.getElementById("capacity-bar");
const summaryFiles = document.getElementById("summary-files");
const summarySize = document.getElementById("summary-size");
const summaryStatus = document.getElementById("summary-status");
const convertButton = document.getElementById("convert-button");
const errorBox = document.getElementById("error-box");
const processingPanel = document.getElementById("processing-panel");
const processingMessage = document.getElementById("processing-message");
const processingBar = document.getElementById("processing-bar");
const processingStages = Array.from(document.querySelectorAll("#processing-stages span"));
const resultsCard = document.getElementById("results-card");

let selectedFiles = [];
let progressTimer = null;
let progressIndex = 0;

const progressMessages = [
  "Uploading source files…",
  "Inspecting file structure with MB-System…",
  "Extracting valid longitude, latitude and depth soundings…",
  "Combining all uploaded surveys…",
  "Building the selected output grid…",
  "Applying the shallowest-positive-depth rule…",
  "Validating Olex latitude longitude depth rows…",
  "Compressing the final Olex .gz file…"
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function estimateWorkingBytes(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".gz")) {
    return Math.min(file.size * 3.2, 500 * 1024 * 1024);
  }
  return file.size;
}

function totalEstimatedBytes() {
  return selectedFiles.reduce((sum, file) => sum + estimateWorkingBytes(file), 0);
}

function syncNativeFileInput() {
  const transfer = new DataTransfer();
  selectedFiles.forEach(file => transfer.items.add(file));
  fileInput.files = transfer.files;
}

function addFiles(files) {
  const existingKeys = new Set(selectedFiles.map(file => `${file.name}:${file.size}:${file.lastModified}`));
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".mb57") && !lower.endsWith(".mb57.gz") && !lower.endsWith(".all") && !lower.endsWith(".all.gz")) {
      showError(`Unsupported file: ${file.name}`);
      continue;
    }
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!existingKeys.has(key)) {
      selectedFiles.push(file);
      existingKeys.add(key);
    }
  }
  syncNativeFileInput();
  renderFiles();
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  syncNativeFileInput();
  renderFiles();
}

function renderFiles() {
  const count = selectedFiles.length;
  const estimate = totalEstimatedBytes();
  const compressed = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const percentage = Math.min(100, (estimate / (500 * 1024 * 1024)) * 100);

  fileCount.textContent = `${count} file${count === 1 ? "" : "s"} uploaded`;
  estimatedSize.textContent = `Estimated decompressed size: ${formatMb(estimate)} / 500 MB`;
  capacityBar.style.width = `${percentage}%`;
  capacityBar.classList.toggle("warning", percentage >= 80 && percentage < 100);
  capacityBar.classList.toggle("danger", percentage >= 100);
  summaryFiles.textContent = String(count);
  summarySize.textContent = formatMb(estimate);
  summaryStatus.textContent = count ? "Ready" : "Waiting";

  if (!count) {
    fileList.innerHTML = '<p class="empty-state">No files selected</p>';
    return;
  }

  fileList.innerHTML = selectedFiles.map((file, index) => `
    <div class="file-row">
      <span class="valid-mark" aria-hidden="true">✓</span>
      <div class="file-name">
        <strong>${escapeHtml(file.name)}</strong>
        <small>${formatMb(file.size)}</small>
      </div>
      <button type="button" class="remove-file" data-index="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button>
    </div>
  `).join("");

  fileList.querySelectorAll(".remove-file").forEach(button => {
    button.addEventListener("click", () => removeFile(Number(button.dataset.index)));
  });
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function hideError() {
  errorBox.classList.add("hidden");
  errorBox.textContent = "";
}

function startProgress() {
  progressIndex = 0;
  processingPanel.classList.remove("hidden");
  processingBar.style.width = "8%";
  processingStages.forEach((stage, index) => stage.classList.toggle("active", index === 0));
  processingMessage.textContent = progressMessages[0];

  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    progressIndex = Math.min(progressIndex + 1, progressMessages.length - 1);
    processingMessage.textContent = progressMessages[progressIndex];
    const progress = Math.min(92, 8 + progressIndex * 12);
    processingBar.style.width = `${progress}%`;
    const activeStage = Math.min(processingStages.length - 1, Math.floor(progressIndex * processingStages.length / progressMessages.length));
    processingStages.forEach((stage, index) => {
      stage.classList.toggle("complete", index < activeStage);
      stage.classList.toggle("active", index === activeStage);
    });
  }, 3500);
}

function finishProgress() {
  clearInterval(progressTimer);
  processingMessage.textContent = "Conversion and validation complete.";
  processingBar.style.width = "100%";
  processingStages.forEach(stage => {
    stage.classList.remove("active");
    stage.classList.add("complete");
  });
}

function stopProgress(message) {
  clearInterval(progressTimer);
  processingMessage.textContent = message;
  processingBar.style.width = "0%";
  processingStages.forEach(stage => stage.classList.remove("active", "complete"));
}

fileInput.addEventListener("change", () => addFiles(Array.from(fileInput.files)));

["dragenter", "dragover"].forEach(eventName => {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach(eventName => {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", event => addFiles(Array.from(event.dataTransfer.files)));

form.addEventListener("submit", async event => {
  event.preventDefault();
  hideError();
  resultsCard.classList.add("hidden");

  if (!selectedFiles.length) {
    showError("Select at least one .mb57, .mb57.gz, .all or .all.gz file.");
    return;
  }

  const estimate = totalEstimatedBytes();
  if (estimate > 500 * 1024 * 1024) {
    showError("The estimated decompressed size exceeds 500 MB. Select fewer or smaller files.");
    return;
  }

  if (!document.getElementById("acknowledgement").checked) {
    showError("Confirm the safety acknowledgement before conversion.");
    return;
  }

  const data = new FormData();
  selectedFiles.forEach(file => data.append("files", file, file.name));
  data.append("output_mode", document.querySelector('input[name="output_mode"]:checked').value);
  data.append("acknowledgement", "true");

  convertButton.disabled = true;
  convertButton.innerHTML = '<span aria-hidden="true">⚙</span> Processing bathymetry…';
  summaryStatus.textContent = "Processing";
  startProgress();

  try {
    const response = await fetch("/api/convert", { method: "POST", body: data });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "The conversion failed.");
    }

    finishProgress();
    summaryStatus.textContent = "Complete";

    document.getElementById("output-name").textContent = payload.output_filename;
    document.getElementById("result-files").textContent = formatNumber(payload.summary.source_file_count);
    document.getElementById("result-input").textContent = formatNumber(payload.summary.accepted_input_points);
    document.getElementById("result-rejected").textContent = formatNumber(payload.summary.rejected_input_points);
    document.getElementById("result-output").textContent = formatNumber(payload.summary.output_grid_cells);
    document.getElementById("result-depth").textContent =
      `${payload.summary.output_depth_range_m.minimum.toFixed(1)}–${payload.summary.output_depth_range_m.maximum.toFixed(1)} m`;
    document.getElementById("result-mode").textContent = payload.summary.output_mode_label;
    document.getElementById("download-link").href = payload.download_url;
    document.getElementById("report-link").href = payload.report_url;
    document.getElementById("checksum").textContent = payload.summary.output_sha256;
    resultsCard.classList.remove("hidden");
    resultsCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    stopProgress("Conversion stopped.");
    summaryStatus.textContent = "Error";
    showError(error.message);
  } finally {
    convertButton.disabled = false;
    convertButton.innerHTML = '<span aria-hidden="true">⚓</span> Convert to Olex .gz';
  }
});

renderFiles();
