const form = document.getElementById("converter-form");
const fileInput = document.getElementById("file");
const dropzone = document.getElementById("dropzone");
const fileList = document.getElementById("file-list");
const compressedSize = document.getElementById("compressed-size");
const capacityBar = document.getElementById("capacity-bar");
const submitButton = document.getElementById("submit-button");
const errorBox = document.getElementById("error");
const results = document.getElementById("results");
const mapPlaceholder = document.getElementById("map-placeholder");
const mapLegend = document.getElementById("map-legend");
const mapStatus = document.getElementById("map-status");
const processSubtitle = document.getElementById("process-subtitle");
const stages = Array.from(document.querySelectorAll("#process-steps > div"));

let map = null;
let surveyLayerGroup = null;
let stageTimer = null;

const surveyColors = ["#ffd21f", "#2cc970", "#ef5350", "#37a9ff", "#a978ff", "#ff8a34", "#20d2cf", "#f062b5"];

function show(element) { element.classList.remove("hidden"); }
function hide(element) { element.classList.add("hidden"); }
function formatNumber(value) { return new Intl.NumberFormat().format(value); }
function formatMb(bytes) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }

function renderFileList() {
  const files = Array.from(fileInput.files);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  compressedSize.textContent = formatMb(total);
  capacityBar.style.width = `${Math.min(100, (total / (500 * 1024 * 1024)) * 100)}%`;
  capacityBar.classList.toggle("capacity-warning", total > 425 * 1024 * 1024);

  if (!files.length) {
    fileList.innerHTML = '<p class="empty-state">No files selected</p>';
    return;
  }

  fileList.innerHTML = files.map((file, index) => `
    <div class="file-row">
      <span class="file-status">✓</span>
      <div><strong>${escapeHtml(file.name)}</strong><small>${formatMb(file.size)}</small></div>
      <span class="file-number">${index + 1}</span>
    </div>
  `).join("");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

fileInput.addEventListener("change", renderFileList);
["dragenter", "dragover"].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault();
  dropzone.classList.add("dragover");
}));
["dragleave", "drop"].forEach(name => dropzone.addEventListener(name, event => {
  event.preventDefault();
  dropzone.classList.remove("dragover");
}));
dropzone.addEventListener("drop", event => {
  if (event.dataTransfer.files.length) {
    fileInput.files = event.dataTransfer.files;
    renderFileList();
  }
});

function resetStages() {
  clearInterval(stageTimer);
  stages.forEach(stage => {
    stage.classList.remove("active", "complete");
    stage.querySelector("small").textContent = "Waiting";
  });
}

function startStages() {
  resetStages();
  let current = 0;
  const labels = ["Uploading files", "Inspecting with MB-System", "Extracting soundings", "Building selected output", "Validating Olex rows", "Compressing final file"];
  const activate = () => {
    stages.forEach((stage, index) => {
      stage.classList.toggle("complete", index < current);
      stage.classList.toggle("active", index === current);
      stage.querySelector("small").textContent = index < current ? "Complete" : index === current ? "Processing" : "Waiting";
    });
    processSubtitle.textContent = labels[current] || "Finalizing";
    current = Math.min(current + 1, stages.length - 1);
  };
  activate();
  stageTimer = setInterval(activate, 3400);
}

function completeStages() {
  clearInterval(stageTimer);
  stages.forEach(stage => {
    stage.classList.remove("active");
    stage.classList.add("complete");
    stage.querySelector("small").textContent = "Complete";
  });
  processSubtitle.textContent = "Conversion and output validation complete";
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true, preferCanvas: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  surveyLayerGroup = L.layerGroup().addTo(map);
}

function renderSurveyMap(surveys) {
  ensureMap();
  surveyLayerGroup.clearLayers();
  mapLegend.innerHTML = "";
  const allBounds = [];

  surveys.forEach((survey, index) => {
    const color = surveyColors[index % surveyColors.length];
    const layer = L.layerGroup();
    const latLngs = [];

    survey.points.forEach(point => {
      const [lat, lon, depth] = point;
      latLngs.push([lat, lon]);
      L.circleMarker([lat, lon], {
        radius: 2.5,
        stroke: false,
        fillColor: color,
        fillOpacity: 0.72,
        renderer: L.canvas()
      }).bindTooltip(
        `<strong>${escapeHtml(survey.filename)}</strong><br>` +
        `Depth: ${depth.toFixed(1)} m<br>` +
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`
      ).addTo(layer);
    });

    layer.addTo(surveyLayerGroup);
    if (latLngs.length) {
      const bounds = L.latLngBounds(latLngs);
      allBounds.push(bounds.getSouthWest(), bounds.getNorthEast());
    }

    mapLegend.insertAdjacentHTML("beforeend", `
      <div class="legend-row">
        <span style="background:${color}"></span>
        <div><strong>${escapeHtml(survey.filename)}</strong><small>${formatNumber(survey.sounding_count)} soundings · ${survey.depth_range_m.minimum.toFixed(1)}–${survey.depth_range_m.maximum.toFixed(1)} m</small></div>
      </div>
    `);
  });

  hide(mapPlaceholder);
  show(mapLegend);
  mapStatus.textContent = `${surveys.length} sonar file${surveys.length === 1 ? "" : "s"} mapped`;
  mapStatus.classList.add("status-pill--ready");

  if (allBounds.length) {
    map.fitBounds(L.latLngBounds(allBounds), { padding: [24, 24] });
  }
  setTimeout(() => map.invalidateSize(), 80);
}

function renderSurveyTable(surveys) {
  const table = document.getElementById("survey-table");
  table.innerHTML = `
    <div class="survey-table__head"><span>Source file</span><span>Soundings</span><span>Depth range</span><span>WGS 84 bounds</span></div>
    ${surveys.map((survey, index) => {
      const color = surveyColors[index % surveyColors.length];
      const b = survey.bounds;
      return `
        <div class="survey-table__row">
          <span><i style="background:${color}"></i><strong>${escapeHtml(survey.filename)}</strong></span>
          <span>${formatNumber(survey.sounding_count)}</span>
          <span>${survey.depth_range_m.minimum.toFixed(1)}–${survey.depth_range_m.maximum.toFixed(1)} m</span>
          <span>${b.south.toFixed(5)}° to ${b.north.toFixed(5)}°<br>${b.west.toFixed(5)}° to ${b.east.toFixed(5)}°</span>
        </div>
      `;
    }).join("")}
  `;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  hide(errorBox);
  hide(results);

  if (!fileInput.files.length) {
    errorBox.textContent = "Select one or more supported multibeam files.";
    show(errorBox);
    return;
  }

  const data = new FormData(form);
  data.set("acknowledgement", document.getElementById("acknowledgement").checked ? "true" : "false");

  submitButton.disabled = true;
  submitButton.textContent = "Processing bathymetry…";
  startStages();

  try {
    const response = await fetch("/api/convert", { method: "POST", body: data });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "The conversion failed.");

    completeStages();
    renderSurveyMap(payload.surveys);
    renderSurveyTable(payload.surveys);

    document.getElementById("output-name").textContent = payload.output_filename;
    document.getElementById("download-link").href = payload.download_url;
    document.getElementById("report-link").href = payload.report_url;
    document.getElementById("source-files").textContent = formatNumber(payload.summary.source_file_count);
    document.getElementById("input-points").textContent = formatNumber(payload.summary.accepted_input_points);
    document.getElementById("grid-cells").textContent = formatNumber(payload.summary.output_grid_cells);
    document.getElementById("depth-range").textContent =
      `${payload.summary.output_depth_range_m.minimum.toFixed(1)}–${payload.summary.output_depth_range_m.maximum.toFixed(1)} m`;
    document.getElementById("method-result").textContent = payload.summary.output_mode_label;
    document.getElementById("checksum").textContent = payload.summary.output_sha256;

    show(results);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    resetStages();
    processSubtitle.textContent = "Conversion stopped";
    errorBox.textContent = error.message;
    show(errorBox);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Convert & validate Olex file";
  }
});

renderFileList();
