'use strict';

// ── Tab navigation ───────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'jobs' && !jobsLoaded) loadJobs('finance');
  });
});

// ── File dropzones ───────────────────────────────────────────────────────────

document.querySelectorAll('.dropzone').forEach(zone => {
  const inputId = zone.dataset.input;
  const input   = document.getElementById(inputId);
  const nameEl  = zone.querySelector('.drop-name');

  zone.addEventListener('click', () => input.click());

  ['dragenter', 'dragover'].forEach(e =>
    zone.addEventListener(e, ev => { ev.preventDefault(); zone.classList.add('drag-over'); })
  );
  ['dragleave', 'drop'].forEach(e =>
    zone.addEventListener(e, ev => { ev.preventDefault(); zone.classList.remove('drag-over'); })
  );
  zone.addEventListener('drop', ev => {
    const file = ev.dataTransfer.files[0];
    if (file) { input.files = ev.dataTransfer.files; showFileName(file.name, nameEl); }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) showFileName(input.files[0].name, nameEl);
  });
});

function showFileName(name, el) {
  el.textContent = name;
}

// ── SSE streaming helper ─────────────────────────────────────────────────────

async function streamRequest(endpoint, body, outputId, actionsId, isJson = false) {
  const out     = document.getElementById(outputId);
  const actions = document.getElementById(actionsId);

  out.innerHTML = `
    <div class="thinking-indicator">
      <div class="thinking-dots"><span></span><span></span><span></span></div>
      Analyzing — this usually takes 15–30 seconds
    </div>`;
  if (actions) actions.style.display = 'none';

  let fullText = '';
  let firstText = false;

  try {
    const fetchOpts = isJson
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST', body };

    const response = await fetch(endpoint, fetchOpts);
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(err.error || 'Request failed');
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') { reader.cancel(); return fullText; }

        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }

        if (msg.error) throw new Error(msg.error);
        if (msg.text) {
          if (!firstText) { out.innerHTML = ''; firstText = true; }
          fullText += msg.text;
          out.innerHTML = `<div class="md-output">${marked.parse(fullText)}</div>`;
          out.scrollTop = out.scrollHeight;
        }
      }
    }
  } catch (err) {
    out.innerHTML = `<div class="error-box">${err.message}</div>`;
    return null;
  }

  if (fullText && actions) actions.style.display = 'flex';
  return fullText;
}

// ── Resume Review ────────────────────────────────────────────────────────────

async function runReview() {
  const fileInput = document.getElementById('review-file');
  const jd        = document.getElementById('review-jd').value.trim();
  const btn       = document.getElementById('review-btn');

  if (!fileInput.files[0]) { toast('Please upload your resume PDF'); return; }
  if (!jd) { toast('Please paste the job description'); return; }

  const fd = new FormData();
  fd.append('resume', fileInput.files[0]);
  fd.append('jobDescription', jd);

  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  try {
    await streamRequest('/api/review', fd, 'review-output', 'review-actions');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze My Resume';
  }
}

// ── Resume Edits ─────────────────────────────────────────────────────────────

async function runRedline() {
  const fileInput = document.getElementById('redline-file');
  const jd        = document.getElementById('redline-jd').value.trim();
  const btn       = document.getElementById('redline-btn');

  if (!fileInput.files[0]) { toast('Please upload your resume PDF'); return; }
  if (!jd) { toast('Please paste the job description'); return; }

  const fd = new FormData();
  fd.append('resume', fileInput.files[0]);
  fd.append('jobDescription', jd);

  btn.disabled = true;
  btn.textContent = 'Editing...';
  try {
    await streamRequest('/api/redline', fd, 'redline-output', 'redline-actions');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Edit My Resume';
  }
}

// ── Open Roles ───────────────────────────────────────────────────────────────

let jobsLoaded    = false;
let currentCat    = 'finance';
let autoRefreshId = null;

async function loadJobs(category, btnEl) {
  document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
  const activeBtn = btnEl || document.querySelector(`[data-cat="${category}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  currentCat = category;
  const grid      = document.getElementById('jobs-grid');
  const live      = document.getElementById('live-jobs');
  const liveLabel = document.getElementById('live-label');

  grid.innerHTML = '<div class="jobs-loading">Loading...</div>';
  live.innerHTML = '';
  liveLabel.style.display = 'none';

  try {
    const res  = await fetch(`/api/jobs?category=${category}`);
    const data = await res.json();
    jobsLoaded = true;

    grid.innerHTML = data.linkedinLinks.map(s => `
      <div class="job-card">
        <div class="job-card-label">${s.label}</div>
        <div class="job-card-links">
          <a class="job-link job-link-li" href="${s.linkedin}" target="_blank" rel="noopener">LinkedIn</a>
          <a class="job-link job-link-in" href="${s.indeed}" target="_blank" rel="noopener">Indeed</a>
        </div>
      </div>`).join('');

    if (data.liveJobs && data.liveJobs.length > 0) {
      liveLabel.style.display = 'block';
      live.innerHTML = data.liveJobs.map(j => {
        const date = j.date
          ? new Date(j.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
        return `
          <div class="live-job">
            <div class="live-job-info">
              <div class="live-job-title">${escHtml(j.title)}</div>
              <div class="live-job-meta">${escHtml(j.category)}${date ? ' &middot; ' + date : ''}</div>
            </div>
            <a class="live-job-link" href="${j.link}" target="_blank" rel="noopener">View</a>
          </div>`;
      }).join('');
    }

    setLastUpdated();
  } catch {
    grid.innerHTML = '<div class="error-box" style="grid-column:1/-1">Could not load jobs. Make sure the server is running.</div>';
  }
}

function setLastUpdated() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Updated just now';
  let mins = 0;
  clearInterval(autoRefreshId);
  autoRefreshId = setInterval(() => {
    mins++;
    if (el) el.textContent = `Updated ${mins} min${mins > 1 ? 's' : ''} ago`;
    if (mins >= 10) {
      loadJobs(currentCat);
    }
  }, 60000);
}

function refreshJobs() {
  loadJobs(currentCat);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Startup Analysis ─────────────────────────────────────────────────────────

async function runStartup() {
  const url = document.getElementById('startup-url').value.trim();
  const btn = document.getElementById('startup-btn');

  if (!url) { toast('Please enter a startup URL'); return; }
  if (!/^https?:\/\/.+/.test(url)) { toast('Please enter a valid URL starting with https://'); return; }

  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  try {
    await streamRequest('/api/startup', { url }, 'startup-output', 'startup-actions', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze This Startup';
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function copyOutput(id) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.innerText || el.textContent)
    .then(() => toast('Copied to clipboard'));
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Init ─────────────────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });
