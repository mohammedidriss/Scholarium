// ============================================================
// Multi-Project Research Assistant — app.js
// ============================================================

// === Global State ===
let currentProjectId = null;
let allProjects = [];
let attachedPdfText = null;
let attachedPdfFilename = null;
let answerStore = [];
let currentAbortController = null;
let allNotes = [];
let currentNoteId = null;
let docFullText = '';
let docCurrentFilename = '';
let docViewerOpen = false;
let allDocs = [];
let allReadingStatuses = {};
let allHighlights = {};
let scrollProgressDebounce = null;
let lastSentProgress = 0;
let currentCitation = null;
let allCollections = [];
let currentJournalId = null;

// === DOM References ===
const chatMessages = document.getElementById('chatMessages');
const questionInput = document.getElementById('questionInput');
const sendBtn = document.getElementById('sendBtn');
const evalContent = document.getElementById('evalContent');
const evalPlaceholder = document.getElementById('evalPlaceholder');
const warningBanner = document.getElementById('warningBanner');
const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const uploadOverlay = document.getElementById('uploadOverlay');
const uploadStatus = document.getElementById('uploadStatus');
const chatFileInput = document.getElementById('chatFileInput');
const attachedFile = document.getElementById('attachedFile');
const attachedName = document.getElementById('attachedName');
const projectSelectionScreen = document.getElementById('projectSelectionScreen');
const projectGrid = document.getElementById('projectGrid');
const workspaceView = document.getElementById('workspaceView');
const activeProjectName = document.getElementById('activeProjectName');

// === Helpers ===
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function projectUrl(path) {
    return `/api/projects/${currentProjectId}${path}`;
}

function requireProject() {
    if (!currentProjectId) {
        addSystemMessage('Please select or create a project first.');
        return false;
    }
    return true;
}

function showProjectScreen() {
    if (projectSelectionScreen) projectSelectionScreen.style.display = 'flex';
    if (workspaceView) workspaceView.style.display = 'none';
}

function showWorkspace() {
    if (projectSelectionScreen) projectSelectionScreen.style.display = 'none';
    if (workspaceView) workspaceView.style.display = 'flex';
}

function exitProject() {
    currentProjectId = null;
    showProjectScreen();
    loadProjects();
}

// ============================================================
// 2. Project Management
// ============================================================

async function loadProjects() {
    try {
        const resp = await fetch('/api/projects');
        allProjects = await resp.json();
        renderProjectGrid(allProjects);
    } catch (err) {
        if (projectGrid) {
            projectGrid.innerHTML = '<p class="project-grid-empty">Failed to load projects.</p>';
        }
    }
}

function renderProjectGrid(projects) {
    if (!projectGrid) return;
    if (projects.length === 0) {
        projectGrid.innerHTML = '<div class="project-grid-empty"><p>No projects yet.</p><p>Click "+ New Project" above to create your first research project.</p></div>';
        return;
    }
    let html = '';
    for (const p of projects) {
        const desc = p.description || 'No description';
        const docCount = typeof p.document_count === 'number' ? p.document_count : 0;
        const date = p.updated_at ? new Date(p.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        html += `<div class="project-grid-card" onclick="selectProject('${escapeHtml(p.id)}')">
            <div class="project-grid-card-name">${escapeHtml(p.name)}</div>
            <div class="project-grid-card-desc">${escapeHtml(desc)}</div>
            <div class="project-grid-card-meta">
                <span>${docCount} document${docCount !== 1 ? 's' : ''}</span>
                <span>${date}</span>
            </div>
            <div class="project-grid-card-actions">
                <button class="project-action-btn" onclick="event.stopPropagation(); renameProject('${escapeHtml(p.id)}')" title="Rename">Rename</button>
                <button class="project-action-btn delete" onclick="event.stopPropagation(); deleteProject('${escapeHtml(p.id)}')" title="Delete">Delete</button>
            </div>
        </div>`;
    }
    projectGrid.innerHTML = html;
}

async function createProject() {
    const name = prompt('New project name:');
    if (!name || !name.trim()) return;
    try {
        const resp = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim() }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            addSystemMessage('Failed to create project: ' + (err.error || resp.statusText));
            return;
        }
        const project = await resp.json();
        allProjects.unshift(project);
        selectProject(project.id);
        renderProjectGrid(allProjects);
    } catch (err) {
        addSystemMessage('Failed to create project: ' + err.message);
    }
}

async function deleteProject(id) {
    const project = allProjects.find(p => p.id === id);
    const name = project ? project.name : id;
    if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.json();
            addSystemMessage('Failed to delete project: ' + (err.error || resp.statusText));
            return;
        }
        allProjects = allProjects.filter(p => p.id !== id);
        if (currentProjectId === id) {
            currentProjectId = null;
            showProjectScreen();
        }
        renderProjectGrid(allProjects);
    } catch (err) {
        addSystemMessage('Failed to delete project: ' + err.message);
    }
}

async function renameProject(id) {
    const project = allProjects.find(p => p.id === id);
    const currentName = project ? project.name : '';
    const newName = prompt('Rename project:', currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;
    try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            addSystemMessage('Failed to rename project: ' + (err.error || resp.statusText));
            return;
        }
        const updated = await resp.json();
        const idx = allProjects.findIndex(p => p.id === id);
        if (idx !== -1) allProjects[idx] = updated;
        renderProjectGrid(allProjects);
        // Update workspace title if renaming the active project
        if (id === currentProjectId && activeProjectName) {
            activeProjectName.textContent = updated.name;
        }
    } catch (err) {
        addSystemMessage('Failed to rename project: ' + err.message);
    }
}

function selectProject(id) {
    currentProjectId = id;

    // Clear all state
    answerStore = [];
    allNotes = [];
    currentNoteId = null;
    allDocs = [];
    allReadingStatuses = {};
    allHighlights = {};
    allCollections = [];
    currentJournalId = null;
    currentCitation = null;

    // Update UI
    const project = allProjects.find(p => p.id === id);
    if (activeProjectName) activeProjectName.textContent = project ? project.name : 'Project';

    showWorkspace();

    if (chatMessages) chatMessages.innerHTML = '';
    if (evalContent) { evalContent.style.display = 'none'; evalContent.innerHTML = ''; }
    if (evalPlaceholder) evalPlaceholder.style.display = 'block';

    if (project) addSystemMessage(`Project: ${project.name}`);

    switchTab('chat');
    reloadProjectData();
}

function reloadProjectData() {
    if (!currentProjectId) return;
    loadDocuments();
    loadNotes();
    loadHistory();
    loadSummaries();
    checkProjectStatus();
    loadReadingStatuses();
    loadCollections();
}

// ============================================================
// 3. Health & Status
// ============================================================

async function checkHealth() {
    try {
        const resp = await fetch('/api/health');
        const services = await resp.json();
        renderHealthPills(services);
    } catch {
        const pills = document.getElementById('healthPills');
        if (pills) pills.innerHTML = '<span class="health-pill error">Health check failed</span>';
    }
}

function renderHealthPills(services) {
    const pills = document.getElementById('healthPills');
    const detail = document.getElementById('healthDetailContent');
    let pillsHtml = '';
    let detailHtml = '';
    for (const svc of services) {
        const icon = svc.status === 'ok' ? '&#10003;' : svc.status === 'warning' ? '&#9888;' : '&#10007;';
        pillsHtml += `<span class="health-pill ${svc.status}">${icon} ${svc.name}</span>`;
        detailHtml += `<div class="health-detail-row ${svc.status}">
            <span class="health-detail-name">${svc.name}</span>
            <span class="health-detail-status">${svc.detail}</span>
        </div>`;
    }
    if (pills) pills.innerHTML = pillsHtml;
    if (detail) detail.innerHTML = detailHtml;
    // Also update home screen health pills
    const homeHealth = document.getElementById('healthPillsHome');
    if (homeHealth) homeHealth.innerHTML = pillsHtml;
}

function toggleHealthDetail() {
    const detail = document.getElementById('healthDetail');
    if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
}

async function checkProjectStatus() {
    if (!currentProjectId) return;
    try {
        const resp = await fetch(projectUrl('/status'));
        const data = await resp.json();
        if (warningBanner) {
            warningBanner.style.display = data.has_documents ? 'none' : 'block';
        }
    } catch { /* ignore */ }
}

// ============================================================
// 4. File Upload & Attachment
// ============================================================

if (chatFileInput) {
    chatFileInput.addEventListener('change', async () => {
        if (!requireProject()) { chatFileInput.value = ''; return; }
        if (chatFileInput.files.length === 0) return;
        const file = chatFileInput.files[0];
        if (!file.name.endsWith('.pdf')) {
            addSystemMessage('Only PDF files can be attached.');
            chatFileInput.value = '';
            return;
        }
        attachedName.textContent = `${file.name} (indexing...)`;
        attachedFile.style.display = 'flex';
        const form = new FormData();
        form.append('file', file);
        try {
            const resp = await fetch(projectUrl('/upload'), { method: 'POST', body: form });
            const data = await resp.json();
            if (data.success) {
                attachedPdfText = 'indexed';
                attachedPdfFilename = data.filename;
                attachedName.textContent = `${data.filename} (indexed, ${data.chunks_added} chunks)`;
                checkProjectStatus();
                checkHealth();
            } else {
                addSystemMessage('Failed to index PDF: ' + (data.error || 'unknown error'));
                removeAttachment();
            }
        } catch (err) {
            addSystemMessage('Failed to index PDF: ' + err.message);
            removeAttachment();
        }
        chatFileInput.value = '';
    });
}

if (fileInput) {
    fileInput.addEventListener('change', () => {
        if (!requireProject()) { fileInput.value = ''; return; }
        if (fileInput.files.length > 0) {
            uploadFiles(fileInput.files);
        }
    });
}

if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (!requireProject()) return;
        const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.pdf'));
        if (files.length === 1) {
            const dt = new DataTransfer();
            dt.items.add(files[0]);
            chatFileInput.files = dt.files;
            chatFileInput.dispatchEvent(new Event('change'));
        } else if (files.length > 1) {
            uploadFiles(files);
        }
    });
}

async function uploadFiles(files) {
    if (!requireProject()) return;
    uploadOverlay.style.display = 'flex';
    let total = files.length, done = 0;

    for (const file of files) {
        uploadStatus.textContent = `Indexing ${file.name} (${done + 1}/${total})...`;
        const form = new FormData();
        form.append('file', file);
        try {
            const resp = await fetch(projectUrl('/upload'), { method: 'POST', body: form });
            const data = await resp.json();
            done++;
            addSystemMessage(data.message || `Uploaded ${file.name}`);
        } catch (err) {
            addSystemMessage(`Failed to upload ${file.name}: ${err.message}`);
        }
    }

    uploadOverlay.style.display = 'none';
    fileInput.value = '';
    checkProjectStatus();
}

function removeAttachment() {
    attachedPdfText = null;
    attachedPdfFilename = null;
    if (attachedFile) attachedFile.style.display = 'none';
    if (attachedName) attachedName.textContent = '';
    if (chatFileInput) chatFileInput.value = '';
}

// ============================================================
// 5. Messages
// ============================================================

function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addUserMessage(text) {
    const div = document.createElement('div');
    div.className = 'message user-message';
    div.innerHTML = `<div class="message-label">You</div><div class="message-body">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addAssistantMessage(result) {
    const div = document.createElement('div');
    div.className = 'message assistant-message';
    const answerId = answerStore.length;
    answerStore.push(result);

    let html = `<div class="message-label">Research Assistant <span class="model-tag">${escapeHtml(result.respondent_model)}</span></div>`;

    if (!result.respondent_success) {
        html += `<div class="message-body error-text">${escapeHtml(result.respondent_error || 'Unknown error')}</div>`;
    } else {
        html += `<div class="message-body">${formatAnswer(result.answer)}</div>`;
    }

    if (result.chunks && result.chunks.length > 0) {
        html += `<details class="sources-section"><summary>Sources (${result.chunks.length} chunks used)</summary><div class="sources-list">`;
        for (const chunk of result.chunks) {
            html += `<div class="source-chunk">
                <div class="source-header">${escapeHtml(chunk.source)} &mdash; Chunk ${chunk.chunk_index} <span class="distance">(distance: ${chunk.distance})</span></div>
                <div class="source-text">${escapeHtml(chunk.text)}</div>
            </div>`;
        }
        html += `</div></details>`;
    }

    if (result.respondent_success && result.answer) {
        html += `<div class="answer-export-actions">
            <button class="answer-copy-btn" onclick="copyAnswer(${answerId}, this)">Copy</button>
            <button class="answer-export-btn" onclick="exportAnswer(${answerId}, 'pdf')">Export PDF</button>
            <button class="answer-export-btn" onclick="exportAnswer(${answerId}, 'docx')">Export DOCX</button>
        </div>`;
    }

    div.innerHTML = html;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Store the current eval result so we can show details on click
let currentEvalResult = null;

function updateEvalPanel(result) {
    if (!result.scores) return;
    currentEvalResult = result;
    if (evalPlaceholder) evalPlaceholder.style.display = 'none';
    if (evalContent) evalContent.style.display = 'block';

    let html = '';
    if (result.judge_error) {
        html += `<div class="eval-warning">${escapeHtml(result.judge_error)}</div>`;
    }
    html += `<div class="judge-model">Judge: ${escapeHtml(result.judge_model)}</div>`;

    const dims = [
        { key: 'faithfulness', label: 'Faithfulness', desc: 'Grounded in documents' },
        { key: 'relevance', label: 'Relevance', desc: 'Answers the question' },
        { key: 'hallucination', label: 'No Hallucination', desc: 'Nothing fabricated' },
        { key: 'completeness', label: 'Completeness', desc: 'Covers key points' },
    ];

    for (const dim of dims) {
        const data = result.scores[dim.key];
        if (!data) continue;
        const score = data.score;
        const pct = Math.round(score * 100);
        const color = score >= 0.7 ? 'green' : score >= 0.4 ? 'amber' : 'red';
        html += `
            <div class="eval-dimension eval-dimension-clickable" onclick="showEvalDetail('${dim.key}')">
                <div class="dim-header">
                    <span class="dim-label">${dim.label}</span>
                    <span class="dim-score ${color}">${pct}%</span>
                </div>
                <div class="dim-desc">${dim.desc}</div>
                <div class="score-bar">
                    <div class="score-fill ${color}" style="width: ${pct}%"></div>
                </div>
                <div class="dim-explanation">${escapeHtml(data.explanation)}</div>
            </div>`;
    }

    if (evalContent) evalContent.innerHTML = html;
}

function showEvalDetail(dimKey) {
    if (!currentEvalResult || !currentEvalResult.scores) return;
    const data = currentEvalResult.scores[dimKey];
    if (!data) return;

    const dimMeta = {
        faithfulness: { label: 'Faithfulness', desc: 'Whether the answer is grounded in the source documents. A high score means every claim can be traced back to the retrieved context.' },
        relevance: { label: 'Relevance', desc: 'Whether the answer directly addresses the question asked. A high score means the answer stays on topic and covers what was asked.' },
        hallucination: { label: 'No Hallucination', desc: 'Whether the model avoided fabricating information. A high score (close to 100%) means nothing was invented outside the source documents.' },
        completeness: { label: 'Completeness', desc: 'Whether all important points from the context are covered. A high score means the answer didn\'t miss critical information.' },
    }[dimKey] || { label: dimKey, desc: '' };

    const pct = Math.round((data.score || 0) * 100);
    const color = data.score >= 0.7 ? 'green' : data.score >= 0.4 ? 'amber' : 'red';

    const listView = document.getElementById('evalListView');
    const detailView = document.getElementById('evalDetailView');
    const detailContent = document.getElementById('evalDetailContent');
    if (!detailView || !detailContent) return;

    detailContent.innerHTML = `
        <div class="eval-detail-score">
            <div class="eval-detail-label">${escapeHtml(dimMeta.label)}</div>
            <div class="eval-detail-pct ${color}">${pct}%</div>
        </div>
        <div class="score-bar" style="margin-bottom:24px;"><div class="score-fill ${color}" style="width:${pct}%"></div></div>
        <div class="eval-detail-section">
            <h3>What this means</h3>
            <p>${escapeHtml(dimMeta.desc)}</p>
        </div>
        <div class="eval-detail-section">
            <h3>Judge's explanation</h3>
            <p>${escapeHtml(data.explanation || 'No explanation provided.')}</p>
        </div>
        ${currentEvalResult.judge_model ? `<div class="eval-detail-section"><h3>Judge Model</h3><p>${escapeHtml(currentEvalResult.judge_model)}</p></div>` : ''}
    `;

    listView.style.display = 'none';
    detailView.style.display = 'flex';
}

function closeEvalDetail() {
    document.getElementById('evalListView').style.display = 'flex';
    document.getElementById('evalDetailView').style.display = 'none';
}

function formatAnswer(text) {
    let html = escapeHtml(text);
    html = html.replace(/\[Source:\s*([^\],]+),\s*Chunk\s*(\d+)\]/g,
        '<span class="citation">[Source: $1, Chunk $2]</span>');
    html = html.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');
    return `<p>${html}</p>`;
}

// ============================================================
// 6. Query
// ============================================================

function cancelQuery() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
}

async function sendQuestion() {
    if (!requireProject()) return;
    const rawQuestion = questionInput.value.trim();
    if (!rawQuestion && !attachedPdfText) return;

    let question = rawQuestion;
    let displayQuestion = rawQuestion;
    if (docViewerOpen && docCurrentFilename) {
        question = `Regarding the document "${docCurrentFilename}": ${rawQuestion}`;
        displayQuestion = `${rawQuestion}\n[doc: ${docCurrentFilename}]`;
        closeDocViewer();
    } else if (attachedPdfText) {
        question = rawQuestion
            ? `Regarding the document "${attachedPdfFilename}": ${rawQuestion}`
            : `Analyze and summarize the key findings from the document "${attachedPdfFilename}"`;
        displayQuestion = rawQuestion
            ? `${rawQuestion}\n[attached: ${attachedPdfFilename}]`
            : `Analyze: [attached: ${attachedPdfFilename}]`;
        removeAttachment();
    }

    addUserMessage(displayQuestion);
    questionInput.value = '';

    sendBtn.textContent = 'Cancel';
    sendBtn.classList.add('cancel-mode');
    sendBtn.onclick = cancelQuery;

    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message loading-message';
    loadingDiv.innerHTML = '<div class="spinner"></div><span>Searching documents and generating answer...</span>';
    chatMessages.appendChild(loadingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    currentAbortController = new AbortController();

    try {
        const resp = await fetch(projectUrl('/query'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
            signal: currentAbortController.signal,
        });
        const result = await resp.json();

        loadingDiv.remove();
        addAssistantMessage(result);
        updateEvalPanel(result);

    } catch (err) {
        loadingDiv.remove();
        if (err.name === 'AbortError') {
            addSystemMessage('Query cancelled.');
        } else {
            addSystemMessage(`Error: ${err.message}`);
        }
    }

    currentAbortController = null;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('cancel-mode');
    sendBtn.onclick = sendQuestion;
}

// ============================================================
// 7. Tab Switching
// ============================================================

function switchTab(tab) {
    // Update nav buttons
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    // Show/hide tab pages
    const tabIds = ['tabChat', 'tabEval', 'tabNotes', 'tabHistory', 'tabSummaries', 'tabDocs', 'tabMatrix', 'tabJournal', 'tabManuscript'];
    const tabKeys = ['chat', 'eval', 'notes', 'history', 'summaries', 'docs', 'matrix', 'journal', 'manuscript'];

    tabIds.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.style.display = tabKeys[i] === tab ? 'flex' : 'none';
    });

    // Reset detail views when entering their tabs
    if (tab === 'history') {
        const hlv = document.getElementById('historyListView');
        const hdv = document.getElementById('historyDetailView');
        if (hlv) hlv.style.display = 'flex';
        if (hdv) hdv.style.display = 'none';
    }
    if (tab === 'eval') {
        const elv = document.getElementById('evalListView');
        const edv = document.getElementById('evalDetailView');
        if (elv) elv.style.display = 'flex';
        if (edv) edv.style.display = 'none';
    }

    if (!requireProject()) return;
    if (tab === 'history') loadHistory();
    if (tab === 'docs') { loadDocuments(); loadCollections(); }
    if (tab === 'summaries') loadSummaries();
    if (tab === 'matrix') loadMatrix();
    if (tab === 'journal') { loadTodayJournal(); loadJournalHistory(); }
    if (tab === 'manuscript') { loadManuscripts(); loadWritingStreak(); }
}

// ============================================================
// 8. Notes (with bi-directional linking)
// ============================================================

async function loadNotes() {
    if (!currentProjectId) return;
    try {
        const resp = await fetch(projectUrl('/notes'));
        allNotes = await resp.json();
        refreshTagFilter();
        renderNotesList(allNotes);
    } catch { /* ignore on initial load */ }
}

function refreshTagFilter() {
    const select = document.getElementById('tagFilter');
    if (!select) return;
    const tagSet = new Set();
    for (const n of allNotes) {
        for (const t of (n.tags || [])) tagSet.add(t);
    }
    const currentValue = select.value;
    const tags = [...tagSet].sort();
    let html = '<option value="all">All Tags</option>';
    for (const t of tags) html += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`;
    select.innerHTML = html;
    if ([...tagSet].includes(currentValue)) select.value = currentValue;
}

function renderNotesList(notes) {
    const list = document.getElementById('notesList');
    if (!list) return;
    const visibleNotes = notes || allNotes;
    if (!visibleNotes || visibleNotes.length === 0) {
        list.innerHTML = '<p class="notes-empty">No notes match. Clear filters or click "+ New Note" to create one.</p>';
        return;
    }
    let html = '';
    for (const note of visibleNotes) {
        const preview = note.content.length > 80 ? note.content.slice(0, 80) + '...' : note.content;
        const date = new Date(note.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const linkCount = getBacklinks(note.title).length;
        const linkBadge = linkCount > 0 ? `<span class="note-link-badge">${linkCount} link${linkCount > 1 ? 's' : ''}</span>` : '';
        const tagsHtml = (note.tags && note.tags.length)
            ? `<div class="note-card-tags">${note.tags.map(t => `<span class="note-tag">${escapeHtml(t)}</span>`).join('')}</div>`
            : '';
        html += `<div class="note-card" onclick="openNote('${note.id}')">
            <div class="note-card-title">${escapeHtml(note.title)} ${linkBadge}</div>
            <div class="note-card-preview">${escapeHtml(preview || 'Empty note')}</div>
            ${tagsHtml}
            <div class="note-card-date">${date}</div>
        </div>`;
    }
    list.innerHTML = html;
}

function searchNotes() {
    const q = (document.getElementById('notesSearchInput')?.value || '').trim().toLowerCase();
    const tagFilter = document.getElementById('tagFilter')?.value || 'all';
    const filtered = allNotes.filter(n => {
        const haystack = `${n.title} ${n.content} ${(n.tags || []).join(' ')}`.toLowerCase();
        const matchesQuery = !q || haystack.includes(q);
        const matchesTag = tagFilter === 'all' || (n.tags || []).includes(tagFilter);
        return matchesQuery && matchesTag;
    });
    renderNotesList(filtered);
}

async function createNote() {
    if (!requireProject()) return;
    try {
        const resp = await fetch(projectUrl('/notes'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Untitled Note', content: '', tags: [] }),
        });
        const note = await resp.json();
        allNotes.unshift(note);
        renderNotesList(allNotes);
        openNote(note.id);
    } catch (err) {
        addSystemMessage('Failed to create note: ' + err.message);
    }
}

function openNote(id) {
    const note = allNotes.find(n => n.id === id);
    if (!note) return;
    currentNoteId = id;
    document.getElementById('noteTitleInput').value = note.title;
    document.getElementById('noteContentInput').value = note.content;
    const tagsInput = document.getElementById('noteTagsInput');
    if (tagsInput) tagsInput.value = (note.tags || []).join(', ');
    document.getElementById('noteEditor').style.display = 'block';
    document.getElementById('notesList').style.display = 'none';
    const searchBar = document.getElementById('notesSearchBar');
    if (searchBar) searchBar.style.display = 'none';
    const newBtn = document.querySelector('.new-note-btn');
    if (newBtn) newBtn.style.display = 'none';
    renderBacklinks(note.title);
}

function closeNoteEditor() {
    saveCurrentNote();
    document.getElementById('noteEditor').style.display = 'none';
    document.getElementById('notesList').style.display = 'block';
    const searchBar = document.getElementById('notesSearchBar');
    if (searchBar) searchBar.style.display = 'flex';
    const newBtn = document.querySelector('.new-note-btn');
    if (newBtn) newBtn.style.display = 'block';
    currentNoteId = null;
}

async function saveCurrentNote() {
    if (!currentNoteId || !currentProjectId) return;
    const title = document.getElementById('noteTitleInput').value.trim() || 'Untitled Note';
    const content = document.getElementById('noteContentInput').value;
    const tagsRaw = document.getElementById('noteTagsInput')?.value || '';
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);
    try {
        const resp = await fetch(projectUrl(`/notes/${currentNoteId}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, content, tags }),
        });
        const updated = await resp.json();
        const idx = allNotes.findIndex(n => n.id === currentNoteId);
        if (idx !== -1) allNotes[idx] = updated;
        allNotes.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        refreshTagFilter();
        renderNotesList(allNotes);
    } catch { /* silent fail */ }
}

async function deleteCurrentNote() {
    if (!currentNoteId || !currentProjectId) return;
    try {
        await fetch(projectUrl(`/notes/${currentNoteId}`), { method: 'DELETE' });
        allNotes = allNotes.filter(n => n.id !== currentNoteId);
        refreshTagFilter();
        renderNotesList(allNotes);
        document.getElementById('noteEditor').style.display = 'none';
        document.getElementById('notesList').style.display = 'block';
        const searchBar = document.getElementById('notesSearchBar');
        if (searchBar) searchBar.style.display = 'flex';
        const newBtn = document.querySelector('.new-note-btn');
        if (newBtn) newBtn.style.display = 'block';
        currentNoteId = null;
    } catch { /* silent fail */ }
}

function renderNoteContentWithLinks(content) {
    let html = escapeHtml(content);
    html = html.replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
        const note = allNotes.find(n => n.title === title);
        if (note) {
            return `<a href="#" class="note-wiki-link" onclick="event.preventDefault(); openNoteByTitle('${escapeHtml(title)}')">${escapeHtml(title)}</a>`;
        }
        return `<span class="note-wiki-link broken">${escapeHtml(title)}</span>`;
    });
    return html;
}

function openNoteByTitle(title) {
    const note = allNotes.find(n => n.title === title);
    if (note) {
        openNote(note.id);
    } else {
        addSystemMessage(`Note "${title}" not found.`);
    }
}

function getBacklinks(noteTitle) {
    const pattern = `[[${noteTitle}]]`;
    return allNotes.filter(n => n.title !== noteTitle && n.content.includes(pattern));
}

function renderBacklinks(noteTitle) {
    const backlinksSection = document.getElementById('backlinksSection');
    const backlinksList = document.getElementById('backlinksList');
    if (!backlinksSection || !backlinksList) return;

    const backlinks = getBacklinks(noteTitle);
    if (backlinks.length === 0) {
        backlinksSection.style.display = 'none';
        backlinksList.innerHTML = '';
        return;
    }

    backlinksSection.style.display = 'block';
    let html = '';
    for (const bl of backlinks) {
        const preview = bl.content.length > 60 ? bl.content.slice(0, 60) + '...' : bl.content;
        html += `<div class="backlink-item" onclick="openNote('${bl.id}')">
            <div class="backlink-title">${escapeHtml(bl.title)}</div>
            <div class="backlink-preview">${escapeHtml(preview)}</div>
        </div>`;
    }
    backlinksList.innerHTML = html;
}

function exportNote(format) {
    if (!currentNoteId || !currentProjectId) return;
    saveCurrentNote();
    window.open(projectUrl(`/notes/${currentNoteId}/export?format=${format}`), '_blank');
}

// ============================================================
// 9. History
// ============================================================

async function loadHistory() {
    if (!currentProjectId) return;
    try {
        const resp = await fetch(projectUrl('/history'));
        const history = await resp.json();
        renderHistory(history);
    } catch { /* ignore */ }
}

function renderHistory(history) {
    const list = document.getElementById('historyList');
    const clearBtn = document.getElementById('clearHistoryBtn');
    if (!history || history.length === 0) {
        if (list) list.innerHTML = '<p class="history-empty">No conversation history yet.</p>';
        if (clearBtn) clearBtn.style.display = 'none';
        return;
    }
    if (clearBtn) clearBtn.style.display = 'block';
    let html = '';
    for (const entry of history) {
        const date = new Date(entry.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const answerPreview = entry.answer.length > 100 ? entry.answer.slice(0, 100) + '...' : entry.answer;
        let avgScore = null;
        if (entry.scores) {
            const vals = Object.values(entry.scores).map(s => s.score).filter(v => typeof v === 'number');
            if (vals.length > 0) avgScore = vals.reduce((a, b) => a + b, 0) / vals.length;
        }
        const scoreColor = avgScore === null ? '' : avgScore >= 0.7 ? 'green' : avgScore >= 0.4 ? 'amber' : 'red';
        const scoreText = avgScore !== null ? `${Math.round(avgScore * 100)}%` : '--';
        html += `<div class="history-card" onclick='replayHistory(${JSON.stringify(entry).replace(/'/g, "&#39;")})'>
            <div class="history-question">${escapeHtml(entry.question)}</div>
            <div class="history-answer-preview">${escapeHtml(answerPreview)}</div>
            <div class="history-meta">
                <span class="history-date">${date}</span>
                <span class="history-score ${scoreColor}">${scoreText}</span>
            </div>
        </div>`;
    }
    if (list) list.innerHTML = html;
}

function replayHistory(entry) {
    // Show detail view inline within History tab
    const listView = document.getElementById('historyListView');
    const detailView = document.getElementById('historyDetailView');
    const detailContent = document.getElementById('historyDetailContent');
    if (!detailView || !detailContent) return;

    const date = new Date(entry.timestamp).toLocaleString();
    const modelLine = entry.respondent_model
        ? `<div class="history-detail-meta">Model: ${escapeHtml(entry.respondent_model)} · Judge: ${escapeHtml(entry.judge_model || 'none')} · ${date}</div>`
        : '';

    let scoresHtml = '';
    if (entry.scores) {
        const dims = [
            { key: 'faithfulness', label: 'Faithfulness' },
            { key: 'relevance', label: 'Relevance' },
            { key: 'hallucination', label: 'No Hallucination' },
            { key: 'completeness', label: 'Completeness' },
        ];
        scoresHtml = '<div class="history-detail-scores">';
        for (const dim of dims) {
            const s = entry.scores[dim.key];
            if (!s) continue;
            const pct = Math.round((s.score || 0) * 100);
            const color = s.score >= 0.7 ? 'green' : s.score >= 0.4 ? 'amber' : 'red';
            scoresHtml += `<div class="eval-dimension">
                <div class="dim-header"><span class="dim-label">${dim.label}</span><span class="dim-score ${color}">${pct}%</span></div>
                <div class="score-bar"><div class="score-fill ${color}" style="width:${pct}%"></div></div>
                <div class="dim-explanation">${escapeHtml(s.explanation || '')}</div>
            </div>`;
        }
        scoresHtml += '</div>';
    }

    detailContent.innerHTML = `
        <div class="history-detail-section">
            <h3>Question</h3>
            <div class="history-detail-question">${escapeHtml(entry.question)}</div>
        </div>
        <div class="history-detail-section">
            <h3>Answer</h3>
            <div class="history-detail-answer">${formatAnswer(entry.answer)}</div>
        </div>
        ${modelLine}
        ${scoresHtml ? `<div class="history-detail-section"><h3>Evaluation Scores</h3>${scoresHtml}</div>` : ''}
    `;

    listView.style.display = 'none';
    detailView.style.display = 'flex';
}

function closeHistoryDetail() {
    document.getElementById('historyListView').style.display = 'flex';
    document.getElementById('historyDetailView').style.display = 'none';
}

async function clearHistory() {
    if (!currentProjectId) return;
    try {
        await fetch(projectUrl('/history'), { method: 'DELETE' });
        renderHistory([]);
    } catch { /* ignore */ }
}

// ============================================================
// 10. Copy & Export
// ============================================================

async function copyAnswer(answerId, btn) {
    const result = answerStore[answerId];
    if (!result) return;
    try {
        await navigator.clipboard.writeText(result.answer);
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 2000);
    } catch {
        addSystemMessage('Failed to copy -- check browser clipboard permissions.');
    }
}

async function exportAnswer(answerId, format) {
    if (!currentProjectId) return;
    const result = answerStore[answerId];
    if (!result) return;
    try {
        const resp = await fetch(projectUrl('/answer/export'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                format,
                question: result.question || '',
                answer: result.answer,
                scores: result.scores || {},
                model: result.respondent_model || '',
                timestamp: result.timestamp || '',
            }),
        });
        if (!resp.ok) throw new Error('Export failed');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `research_answer.${format}`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        addSystemMessage('Export failed: ' + err.message);
    }
}

// ============================================================
// 11. Document Viewer (Full Scroll)
// ============================================================

async function loadDocuments() {
    if (!currentProjectId) return;
    try {
        const resp = await fetch(projectUrl('/documents'));
        allDocs = await resp.json();
        await loadReadingStatuses();
        await loadCollections();
        renderDocList(allDocs);
    } catch (err) {
        addSystemMessage('Failed to load documents: ' + err.message);
    }
}

function renderDocList(docs) {
    const list = document.getElementById('docList');
    const filterBar = document.getElementById('docFilterBar');
    if (!list) return;
    if (!docs || docs.length === 0) {
        list.innerHTML = '<p class="docs-empty">No documents uploaded yet.</p>';
        if (filterBar) filterBar.style.display = 'none';
        return;
    }
    if (filterBar) filterBar.style.display = 'flex';

    let html = '';
    for (const doc of docs) {
        const fn = escapeHtml(doc.filename);
        const enc = encodeURIComponent(doc.filename);
        const statusBadge = getStatusBadge(doc.filename);
        const statusData = allReadingStatuses[doc.filename] || {};
        const progressPct = statusData.progress_pct || 0;
        const progressBar = `<div class="doc-progress-bar"><div class="doc-progress-fill" style="width:${progressPct}%"></div></div>`;

        let collectionTags = '';
        for (const col of allCollections) {
            if (col.documents && col.documents.includes(doc.filename)) {
                collectionTags += `<span class="doc-collection-tag">${escapeHtml(col.name)}</span>`;
            }
        }

        html += `<div class="doc-card">
            <div class="doc-card-info" onclick="openDocViewer('${fn}')">
                <div class="doc-card-name">${fn} ${statusBadge}</div>
                <div class="doc-card-meta">${doc.pages} pages &middot; ${doc.size_display} &middot; ${doc.word_count?.toLocaleString() || '?'} words &middot; ${doc.reading_time || '?'}</div>
                ${progressBar}
                <div class="doc-card-collections">${collectionTags}</div>
            </div>
            <div class="doc-card-actions">
                <button class="doc-action-btn doc-view-btn" onclick="openDocViewer('${fn}')">View</button>
                <button class="doc-action-btn doc-summarize-btn" onclick="summarizeDocument('${fn}')">Summarize</button>
                <button class="doc-action-btn doc-qa-btn" onclick="openDocQA('${fn}')">Q&amp;A</button>
                <button class="doc-action-btn doc-cite-btn" onclick="docCurrentFilename='${fn}'; showCitationModal()">Cite</button>
                <button class="doc-action-btn" onclick="window.open(projectUrl('/documents/${enc}/download'))">DL</button>
                <button class="doc-action-btn doc-delete-btn" onclick="deleteDocument('${fn}')">Del</button>
            </div>
        </div>`;
    }
    list.innerHTML = html;
}

async function openDocViewer(filename) {
    if (!requireProject()) return;
    // Switch to chat tab (where the viewer lives)
    switchTab('chat');
    docCurrentFilename = filename;
    docViewerOpen = true;
    document.getElementById('chatView').style.display = 'none';
    document.getElementById('docViewerPanel').style.display = 'flex';
    document.getElementById('docViewerFilename').textContent = filename;
    document.getElementById('docViewerContent').innerHTML = '<div class="spinner"></div> Loading document...';
    document.getElementById('docSearchInput').value = '';
    document.getElementById('docSearchCount').textContent = '';
    document.getElementById('docSummaryPanel').style.display = 'none';
    document.getElementById('docSummarizeBtn').textContent = 'Summarize';
    document.getElementById('docHighlightsPanel').style.display = 'none';
    questionInput.placeholder = `Ask about "${filename}"...`;

    updateReadingStatus(filename, 'reading');
    lastSentProgress = 0;

    try {
        const resp = await fetch(projectUrl(`/documents/${encodeURIComponent(filename)}/text`));
        const data = await resp.json();
        docFullText = '';
        let html = '';
        for (const page of data.pages) {
            html += `<div class="doc-page-block" data-page="${page.page}"><div class="doc-page-separator">Page ${page.page} of ${data.total_pages}</div><div class="doc-page-text">${escapeHtml(page.text)}</div></div>`;
            docFullText += page.text + '\n';
        }
        document.getElementById('docViewerContent').innerHTML = html;

        await loadHighlights(filename);
        renderHighlightsInViewer();

        const contentEl = document.getElementById('docViewerContent');
        contentEl.addEventListener('scroll', trackScrollProgress);
    } catch (err) {
        document.getElementById('docViewerContent').textContent = 'Failed to load: ' + err.message;
    }

    try {
        const sResp = await fetch(projectUrl('/summaries'));
        const summaries = await sResp.json();
        if (summaries[filename]) {
            showSummaryPanel(summaries[filename]);
        }
    } catch { /* ignore */ }
}

function closeDocViewer() {
    const contentEl = document.getElementById('docViewerContent');
    if (contentEl) {
        contentEl.removeEventListener('scroll', trackScrollProgress);
    }
    if (scrollProgressDebounce) {
        clearTimeout(scrollProgressDebounce);
        scrollProgressDebounce = null;
    }

    docViewerOpen = false;
    document.getElementById('docViewerPanel').style.display = 'none';
    document.getElementById('chatView').style.display = 'block';
    questionInput.placeholder = currentProjectId ? 'Ask a research question...' : 'Select or create a project to get started.';
    docFullText = '';
    docCurrentFilename = '';
}

function openDocQA(filename) {
    openDocViewer(filename);
    setTimeout(() => questionInput.focus(), 300);
}

function searchInDoc() {
    const query = document.getElementById('docSearchInput').value.trim();
    const container = document.getElementById('docViewerContent');
    const countEl = document.getElementById('docSearchCount');
    container.querySelectorAll('.doc-page-text').forEach(el => { el.innerHTML = el.textContent; });
    if (!query || query.length < 2) { countEl.textContent = ''; return; }
    let total = 0;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    container.querySelectorAll('.doc-page-text').forEach(el => {
        const text = el.textContent;
        const matches = text.match(regex);
        if (matches) { total += matches.length; el.innerHTML = text.replace(regex, '<mark class="doc-highlight">$1</mark>'); }
    });
    countEl.textContent = total > 0 ? `${total} found` : 'No matches';
    const first = container.querySelector('.doc-highlight');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveDocNote() {
    if (!requireProject()) return;
    const noteInput = document.getElementById('docViewerNoteInput');
    if (!noteInput) return;
    const content = noteInput.value.trim();
    if (!content) return;
    try {
        await fetch(projectUrl('/notes'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: `Note: ${docCurrentFilename}`, content }),
        });
        noteInput.value = '';
        addSystemMessage(`Note saved for ${docCurrentFilename}`);
        loadNotes();
    } catch (err) {
        addSystemMessage('Failed to save note: ' + err.message);
    }
}

async function deleteDocument(filename) {
    if (!requireProject()) return;
    if (!confirm(`Delete "${filename}"? This will remove it and re-index.`)) return;
    try {
        const resp = await fetch(projectUrl(`/documents/${encodeURIComponent(filename)}`), { method: 'DELETE' });
        const data = await resp.json();
        addSystemMessage(data.message || `Deleted ${filename}`);
        if (docCurrentFilename === filename) closeDocViewer();
        loadDocuments();
        checkProjectStatus();
        checkHealth();
    } catch (err) {
        addSystemMessage('Failed to delete: ' + err.message);
    }
}

// ============================================================
// 12. Reading Status
// ============================================================

async function loadReadingStatuses() {
    if (!currentProjectId) { allReadingStatuses = {}; return; }
    try {
        const resp = await fetch(projectUrl('/reading-status'));
        allReadingStatuses = await resp.json();
    } catch {
        allReadingStatuses = {};
    }
}

async function updateReadingStatus(filename, status) {
    if (!currentProjectId) return;
    try {
        const resp = await fetch(projectUrl(`/reading-status/${encodeURIComponent(filename)}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
        });
        const data = await resp.json();
        allReadingStatuses[filename] = data;
    } catch (err) {
        addSystemMessage('Failed to update reading status: ' + err.message);
    }
}

function getStatusBadge(filename) {
    const statusData = allReadingStatuses[filename];
    if (!statusData || !statusData.status) return '';
    const statusMap = {
        'unread': '<span class="doc-status-badge status-unread">Unread</span>',
        'reading': '<span class="doc-status-badge status-reading">Reading</span>',
        'read': '<span class="doc-status-badge status-read">Read</span>',
    };
    return statusMap[statusData.status] || '';
}

// ============================================================
// 13. Reading Progress
// ============================================================

function trackScrollProgress() {
    if (!docCurrentFilename || !currentProjectId) return;
    if (scrollProgressDebounce) {
        clearTimeout(scrollProgressDebounce);
    }
    scrollProgressDebounce = setTimeout(() => {
        const contentEl = document.getElementById('docViewerContent');
        if (!contentEl) return;
        const scrollTop = contentEl.scrollTop;
        const scrollHeight = contentEl.scrollHeight - contentEl.clientHeight;
        if (scrollHeight <= 0) return;
        const progressPct = Math.round((scrollTop / scrollHeight) * 100);
        const diff = Math.abs(progressPct - lastSentProgress);
        if (diff < 5) return;
        lastSentProgress = progressPct;

        const newStatus = progressPct >= 95 ? 'read' : 'reading';

        fetch(projectUrl(`/reading-status/${encodeURIComponent(docCurrentFilename)}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus, progress_pct: progressPct }),
        }).then(resp => resp.json()).then(data => {
            allReadingStatuses[docCurrentFilename] = data;
        }).catch(() => { /* silent */ });
    }, 2000);
}

// ============================================================
// 14. Highlights
// ============================================================

async function loadHighlights(filename) {
    if (!currentProjectId) { allHighlights = {}; return; }
    try {
        const resp = await fetch(projectUrl(`/highlights/${encodeURIComponent(filename)}`));
        allHighlights = await resp.json();
    } catch {
        allHighlights = {};
    }
}

function highlightSelectedText() {
    if (!requireProject()) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
        addSystemMessage('Select some text in the document first.');
        return;
    }

    const text = selection.toString().trim();
    if (!text) return;

    let page = 1;
    const anchorNode = selection.anchorNode;
    if (anchorNode) {
        const pageBlock = anchorNode.nodeType === Node.ELEMENT_NODE
            ? anchorNode.closest('.doc-page-block')
            : anchorNode.parentElement?.closest('.doc-page-block');
        if (pageBlock && pageBlock.dataset.page) {
            page = parseInt(pageBlock.dataset.page, 10);
        }
    }

    (async () => {
        try {
            const resp = await fetch(projectUrl(`/highlights/${encodeURIComponent(docCurrentFilename)}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, page }),
            });
            const highlight = await resp.json();
            if (!Array.isArray(allHighlights)) allHighlights = [];
            allHighlights.push(highlight);
            renderHighlightsInViewer();
            renderHighlightsList();
            selection.removeAllRanges();
        } catch (err) {
            addSystemMessage('Failed to save highlight: ' + err.message);
        }
    })();
}

function renderHighlightsInViewer() {
    const highlights = Array.isArray(allHighlights) ? allHighlights : [];
    if (highlights.length === 0) return;

    const contentEl = document.getElementById('docViewerContent');
    if (!contentEl) return;
    const pageTexts = contentEl.querySelectorAll('.doc-page-text');

    pageTexts.forEach(pageEl => {
        const pageBlock = pageEl.closest('.doc-page-block');
        const pageNum = pageBlock ? parseInt(pageBlock.dataset.page, 10) : 0;
        const pageHighlights = highlights.filter(h => h.page === pageNum);
        if (pageHighlights.length === 0) return;

        let html = pageEl.textContent;
        html = escapeHtml(html);
        for (const h of pageHighlights) {
            const escaped = escapeHtml(h.text);
            const safeRegex = escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            html = html.replace(new RegExp(safeRegex, 'g'), `<span class="user-highlight">${escaped}</span>`);
        }
        pageEl.innerHTML = html;
    });
}

function toggleHighlightsPanel() {
    const panel = document.getElementById('docHighlightsPanel');
    if (!panel) return;
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = 'block';
        renderHighlightsList();
    } else {
        panel.style.display = 'none';
    }
}

function renderHighlightsList() {
    const list = document.getElementById('docHighlightsList');
    if (!list) return;
    const highlights = Array.isArray(allHighlights) ? allHighlights : [];
    if (highlights.length === 0) {
        list.innerHTML = '<p class="highlights-empty">No highlights yet. Select text and click Highlight.</p>';
        return;
    }
    let html = '';
    for (const h of highlights) {
        const preview = h.text.length > 80 ? h.text.slice(0, 80) + '...' : h.text;
        html += `<div class="highlight-item">
            <div class="highlight-text">${escapeHtml(preview)}</div>
            <div class="highlight-meta">Page ${h.page || '?'}
                <button class="highlight-delete-btn" onclick="deleteHighlight('${h.id}')">Delete</button>
            </div>
        </div>`;
    }
    list.innerHTML = html;
}

async function deleteHighlight(id) {
    if (!currentProjectId) return;
    try {
        await fetch(projectUrl(`/highlights/${encodeURIComponent(docCurrentFilename)}/${id}`), { method: 'DELETE' });
        if (Array.isArray(allHighlights)) {
            allHighlights = allHighlights.filter(h => h.id !== id);
        }
        renderHighlightsInViewer();
        renderHighlightsList();
    } catch (err) {
        addSystemMessage('Failed to delete highlight: ' + err.message);
    }
}

// ============================================================
// 15. Citations
// ============================================================

async function showCitationModal() {
    if (!docCurrentFilename || !currentProjectId) return;
    const modal = document.getElementById('citationModal');
    if (modal) modal.style.display = 'flex';
    document.getElementById('citationText').textContent = 'Generating citation...';

    if (!currentCitation || currentCitation.filename !== docCurrentFilename) {
        try {
            const resp = await fetch(projectUrl(`/citations/${encodeURIComponent(docCurrentFilename)}/generate`), { method: 'POST' });
            currentCitation = await resp.json();
            currentCitation.filename = docCurrentFilename;
            showCitationStyle('apa');
        } catch (err) {
            document.getElementById('citationText').textContent = 'Failed to generate citation: ' + err.message;
        }
    } else {
        showCitationStyle('apa');
    }
}

async function showCitationStyle(style) {
    if (!docCurrentFilename || !currentProjectId) return;
    try {
        const resp = await fetch(projectUrl(`/citations/${encodeURIComponent(docCurrentFilename)}/format?style=${encodeURIComponent(style)}`));
        const data = await resp.json();
        document.getElementById('citationText').textContent = data.citation || data.formatted || 'No citation available.';
    } catch (err) {
        document.getElementById('citationText').textContent = 'Failed to format citation: ' + err.message;
    }
}

function closeCitationModal() {
    const modal = document.getElementById('citationModal');
    if (modal) modal.style.display = 'none';
}

async function copyCitationText() {
    const text = document.getElementById('citationText').textContent;
    try {
        await navigator.clipboard.writeText(text);
        addSystemMessage('Citation copied to clipboard.');
    } catch {
        addSystemMessage('Failed to copy citation -- check browser clipboard permissions.');
    }
}

// ============================================================
// 16. Collections
// ============================================================

async function loadCollections() {
    if (!currentProjectId) { allCollections = []; return; }
    try {
        const resp = await fetch(projectUrl('/collections'));
        allCollections = await resp.json();
        const filter = document.getElementById('collectionFilter');
        if (filter) {
            let html = '<option value="">All Collections</option>';
            for (const col of allCollections) {
                html += `<option value="${escapeHtml(col.id)}">${escapeHtml(col.name)}</option>`;
            }
            filter.innerHTML = html;
        }
    } catch {
        allCollections = [];
    }
}

async function createCollection(name) {
    if (!requireProject()) return;
    if (!name || !name.trim()) return;
    try {
        const resp = await fetch(projectUrl('/collections'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim() }),
        });
        const col = await resp.json();
        allCollections.push(col);
        await loadCollections();
        addSystemMessage(`Collection "${name.trim()}" created.`);
    } catch (err) {
        addSystemMessage('Failed to create collection: ' + err.message);
    }
}

function applyDocFilters() {
    const statusFilter = document.getElementById('statusFilter');
    const collectionFilter = document.getElementById('collectionFilter');
    const selectedStatus = statusFilter ? statusFilter.value : '';
    const selectedCollection = collectionFilter ? collectionFilter.value : '';

    let filtered = allDocs;

    if (selectedStatus) {
        filtered = filtered.filter(doc => {
            const statusData = allReadingStatuses[doc.filename];
            const docStatus = statusData ? statusData.status : 'unread';
            return docStatus === selectedStatus;
        });
    }

    if (selectedCollection) {
        const col = allCollections.find(c => c.id === selectedCollection);
        if (col && col.documents) {
            filtered = filtered.filter(doc => col.documents.includes(doc.filename));
        }
    }

    renderDocList(filtered);
}

// ============================================================
// 17. Summaries
// ============================================================

async function loadSummaries() {
    if (!currentProjectId) return;
    try {
        const [sumResp, docResp] = await Promise.all([
            fetch(projectUrl('/summaries')),
            fetch(projectUrl('/documents')),
        ]);
        const summaries = await sumResp.json();
        const docs = await docResp.json();
        renderSummaries(summaries, docs);
    } catch { /* ignore */ }
}

function renderSummaries(summaries, docs) {
    const list = document.getElementById('summariesList');
    if (!list) return;
    if (!docs || docs.length === 0) { list.innerHTML = '<p class="docs-empty">No documents uploaded.</p>'; return; }
    let html = '';
    for (const doc of docs) {
        const fn = escapeHtml(doc.filename);
        const s = summaries[doc.filename];
        if (s) {
            html += `<details class="summary-card"><summary class="summary-card-header"><span class="summary-card-name">${fn}</span><span class="summary-badge done">Summarized</span></summary><div class="summary-card-body">`;
            html += `<div class="summary-section"><strong>Summary</strong><p>${escapeHtml(s.summary)}</p></div>`;
            if (s.key_findings && s.key_findings.length) html += `<div class="summary-section"><strong>Key Findings</strong><ul>${s.key_findings.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`;
            if (s.methodology) html += `<div class="summary-section"><strong>Methodology</strong><p>${escapeHtml(s.methodology)}</p></div>`;
            html += `<div class="summary-actions"><button class="doc-action-btn doc-qa-btn" onclick="openDocQA('${fn}')">Ask Questions</button><button class="doc-action-btn" onclick="regenerateSummary('${fn}')">Regenerate</button></div>`;
            html += `</div></details>`;
        } else {
            html += `<div class="summary-card-pending"><span class="summary-card-name">${fn}</span><button class="doc-action-btn doc-summarize-btn" onclick="summarizeDocument('${fn}')">Generate Summary</button></div>`;
        }
    }
    list.innerHTML = html;
}

async function summarizeDocument(filename) {
    if (!requireProject()) return;
    addSystemMessage(`Generating summary for ${filename}...`);
    switchTab('summaries');
    try {
        const resp = await fetch(projectUrl(`/documents/${encodeURIComponent(filename)}/summarize`), { method: 'POST' });
        const data = await resp.json();
        if (data.error) addSystemMessage(`Summary failed: ${data.error}`);
        else addSystemMessage(`Summary generated for ${filename}`);
        loadSummaries();
    } catch (err) {
        addSystemMessage('Summarization failed: ' + err.message);
    }
}

async function regenerateSummary(filename) {
    if (!requireProject()) return;
    addSystemMessage(`Regenerating summary for ${filename}...`);
    try {
        await fetch(projectUrl(`/documents/${encodeURIComponent(filename)}/summarize?force=true`), { method: 'POST' });
        addSystemMessage(`Summary regenerated for ${filename}`);
        loadSummaries();
    } catch { /* ignore */ }
}

async function summarizeCurrentDoc() {
    if (!docCurrentFilename || !currentProjectId) return;
    const panel = document.getElementById('docSummaryPanel');
    const body = document.getElementById('docSummaryBody');
    const btn = document.getElementById('docSummarizeBtn');

    if (panel.style.display !== 'none') {
        closeSummaryPanel();
        return;
    }

    panel.style.display = 'flex';
    body.innerHTML = '<div class="spinner"></div> Generating summary...';
    btn.textContent = 'Summarizing...';
    btn.disabled = true;

    try {
        const resp = await fetch(projectUrl(`/documents/${encodeURIComponent(docCurrentFilename)}/summarize`), { method: 'POST' });
        const data = await resp.json();
        if (data.error) {
            body.innerHTML = `<p style="color:var(--red)">${escapeHtml(data.error)}</p>`;
            btn.textContent = 'Summarize';
        } else {
            showSummaryPanel(data);
        }
    } catch (err) {
        body.innerHTML = `<p style="color:var(--red)">Failed: ${escapeHtml(err.message)}</p>`;
        btn.textContent = 'Summarize';
    }
    btn.disabled = false;
}

function showSummaryPanel(s) {
    const panel = document.getElementById('docSummaryPanel');
    const body = document.getElementById('docSummaryBody');
    let html = '';
    if (s.summary) html += `<div class="doc-sum-section"><div class="doc-sum-label">Summary</div><p>${escapeHtml(s.summary)}</p></div>`;
    if (s.key_findings && s.key_findings.length) {
        html += `<div class="doc-sum-section"><div class="doc-sum-label">Key Findings</div><ul>${s.key_findings.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`;
    }
    if (s.methodology) html += `<div class="doc-sum-section"><div class="doc-sum-label">Methodology</div><p>${escapeHtml(s.methodology)}</p></div>`;
    html += `<button class="doc-action-btn" style="margin-top:8px;width:100%" onclick="regenerateCurrentSummary()">Regenerate</button>`;
    if (body) body.innerHTML = html;
    if (panel) panel.style.display = 'flex';
    const btn = document.getElementById('docSummarizeBtn');
    if (btn) btn.textContent = 'Summary';
}

function closeSummaryPanel() {
    const panel = document.getElementById('docSummaryPanel');
    if (panel) panel.style.display = 'none';
    const btn = document.getElementById('docSummarizeBtn');
    if (btn) btn.textContent = 'Summarize';
}

async function regenerateCurrentSummary() {
    if (!docCurrentFilename || !currentProjectId) return;
    const body = document.getElementById('docSummaryBody');
    if (body) body.innerHTML = '<div class="spinner"></div> Regenerating...';
    try {
        const resp = await fetch(projectUrl(`/documents/${encodeURIComponent(docCurrentFilename)}/summarize?force=true`), { method: 'POST' });
        const data = await resp.json();
        if (data.error) {
            if (body) body.innerHTML = `<p style="color:var(--red)">${escapeHtml(data.error)}</p>`;
        } else {
            showSummaryPanel(data);
        }
    } catch { /* ignore */ }
}

// ============================================================
// 18. Literature Matrix
// ============================================================

async function loadMatrix() {
    if (!currentProjectId) return;
    const container = document.getElementById('matrixContainer');
    if (!container) return;
    container.innerHTML = '<div class="spinner"></div> Loading literature matrix...';
    try {
        const resp = await fetch(projectUrl('/matrix'));
        const data = await resp.json();
        if (data.entries && data.entries.length > 0) {
            renderMatrixTable(data.entries);
        } else {
            container.innerHTML = `<div class="matrix-empty">
                <p>No literature matrix generated yet.</p>
                <button class="doc-action-btn" onclick="generateMatrix()">Generate Matrix</button>
            </div>`;
        }
    } catch (err) {
        container.innerHTML = `<div class="matrix-empty">
            <p>Failed to load matrix: ${escapeHtml(err.message)}</p>
            <button class="doc-action-btn" onclick="generateMatrix()">Generate Matrix</button>
        </div>`;
    }
}

async function generateMatrix() {
    if (!requireProject()) return;
    const container = document.getElementById('matrixContainer');
    if (!container) return;
    container.innerHTML = '<div class="spinner"></div> Generating literature matrix... This may take a moment.';
    try {
        const resp = await fetch(projectUrl('/matrix/generate'), { method: 'POST' });
        const data = await resp.json();
        if (data.error) {
            container.innerHTML = `<p style="color:var(--red)">${escapeHtml(data.error)}</p>
                <button class="doc-action-btn" onclick="generateMatrix()">Retry</button>`;
        } else if (data.entries && data.entries.length > 0) {
            renderMatrixTable(data.entries);
        } else {
            container.innerHTML = '<p>No entries generated. Upload documents first.</p>';
        }
    } catch (err) {
        container.innerHTML = `<p style="color:var(--red)">Generation failed: ${escapeHtml(err.message)}</p>
            <button class="doc-action-btn" onclick="generateMatrix()">Retry</button>`;
    }
}

function renderMatrixTable(entries) {
    const container = document.getElementById('matrixContainer');
    if (!container) return;

    let html = `<div class="matrix-toolbar">
        <button class="doc-action-btn" onclick="generateMatrix()">Regenerate</button>
    </div>
    <div class="matrix-table-wrapper">
    <table class="matrix-table">
        <thead>
            <tr>
                <th>Title</th>
                <th>Year</th>
                <th>Methodology</th>
                <th>Findings</th>
                <th>Sample Size</th>
            </tr>
        </thead>
        <tbody>`;

    for (const entry of entries) {
        html += `<tr>
            <td>${escapeHtml(entry.title || '')}</td>
            <td>${escapeHtml(String(entry.year || ''))}</td>
            <td>${escapeHtml(entry.methodology || '')}</td>
            <td>${escapeHtml(entry.findings || '')}</td>
            <td>${escapeHtml(String(entry.sample_size || ''))}</td>
        </tr>`;
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;
}

// ============================================================
// 19. Journal
// ============================================================

async function loadTodayJournal() {
    if (!currentProjectId) return;
    const todayEl = document.getElementById('journalToday');
    const contentEl = document.getElementById('journalContent');
    if (!todayEl) return;

    try {
        const resp = await fetch(projectUrl('/journal/today'));
        const data = await resp.json();
        currentJournalId = data.id || null;

        if (data.auto_stats) {
            renderJournalStats(data.auto_stats);
        }

        if (contentEl) {
            contentEl.value = data.content || '';
        }
    } catch (err) {
        if (todayEl) todayEl.innerHTML = `<p style="color:var(--red)">Failed to load journal: ${escapeHtml(err.message)}</p>`;
    }
}

async function saveJournalEntry() {
    if (!currentProjectId) {
        addSystemMessage('No project selected.');
        return;
    }
    const contentEl = document.getElementById('journalContent');
    if (!contentEl) return;
    const content = contentEl.value;

    // If no journal ID yet, load today's (creates one on backend)
    if (!currentJournalId) {
        try {
            const resp = await fetch(projectUrl('/journal/today'));
            const data = await resp.json();
            currentJournalId = data.id || null;
        } catch { /* ignore */ }
    }
    if (!currentJournalId) {
        addSystemMessage('Failed to initialize journal entry.');
        return;
    }

    try {
        const resp = await fetch(projectUrl(`/journal/${encodeURIComponent(currentJournalId)}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        addSystemMessage('Journal entry saved.');
    } catch (err) {
        addSystemMessage('Failed to save journal: ' + err.message);
    }
}

async function loadJournalHistory() {
    if (!currentProjectId) return;
    const pastEl = document.getElementById('journalPast');
    if (!pastEl) return;

    try {
        const resp = await fetch(projectUrl('/journal'));
        const entries = await resp.json();

        if (!entries || entries.length === 0) {
            pastEl.innerHTML = '<p class="journal-empty">No past journal entries.</p>';
            return;
        }

        let html = '<h3>Past Entries</h3>';
        for (const entry of entries) {
            const date = new Date(entry.date || entry.created_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            const preview = entry.content
                ? (entry.content.length > 120 ? entry.content.slice(0, 120) + '...' : entry.content)
                : 'Empty entry';
            const statsHtml = entry.stats
                ? `<span class="journal-past-stats">${entry.stats.qa_count || 0} Q&amp;A, ${entry.stats.docs_viewed || 0} docs</span>`
                : '';
            html += `<div class="journal-past-card">
                <div class="journal-past-date">${date} ${statsHtml}</div>
                <div class="journal-past-preview">${escapeHtml(preview)}</div>
            </div>`;
        }
        pastEl.innerHTML = html;
    } catch (err) {
        pastEl.innerHTML = `<p style="color:var(--red)">Failed to load journal history: ${escapeHtml(err.message)}</p>`;
    }
}

function renderJournalStats(stats) {
    const statsEl = document.getElementById('journalStats');
    if (!statsEl) return;

    const qaCount = stats.qa_count || 0;
    const docsViewed = stats.docs_viewed || 0;

    statsEl.innerHTML = `<div class="journal-stat-cards">
        <div class="journal-stat-card">
            <div class="journal-stat-value">${qaCount}</div>
            <div class="journal-stat-label">Questions Asked</div>
        </div>
        <div class="journal-stat-card">
            <div class="journal-stat-value">${docsViewed}</div>
            <div class="journal-stat-label">Docs Viewed</div>
        </div>
    </div>`;
}

// ============================================================
// 20. Restart
// ============================================================

async function restartApp() {
    const input = prompt('Type "restart" to confirm restarting the server:');
    if (!input || input.trim().toLowerCase() !== 'restart') {
        if (input !== null) addSystemMessage('Restart cancelled -- you must type "restart" to confirm.');
        return;
    }
    try {
        await fetch('/api/restart', { method: 'POST' });
        uploadOverlay.style.display = 'flex';
        uploadStatus.textContent = 'Restarting server...';
        let attempts = 0;
        const poll = setInterval(async () => {
            attempts++;
            try {
                const r = await fetch('/api/health');
                if (r.ok) {
                    clearInterval(poll);
                    uploadOverlay.style.display = 'none';
                    window.location.reload();
                }
            } catch { /* server still restarting */ }
            if (attempts > 30) {
                clearInterval(poll);
                uploadOverlay.style.display = 'none';
                addSystemMessage('Restart is taking longer than expected. Refresh the page manually.');
            }
        }, 2000);
    } catch {
        addSystemMessage('Failed to restart.');
    }
}

// ============================================================
// Manuscripts (Batch B)
// ============================================================

let allManuscripts = [];
let currentManuscriptId = null;
let currentChapterId = null;
let quillEditor = null;
let writingStreakData = { streak: 0, today_words: 0 };
let _quillSaveTimer = null;
let _allCitationsCache = [];

async function loadManuscripts() {
    if (!requireProject()) return;
    try {
        const resp = await fetch(projectUrl('/manuscripts'));
        if (!resp.ok) throw new Error('Failed to load manuscripts');
        allManuscripts = await resp.json();
        renderManuscriptList();
    } catch (err) {
        addSystemMessage('Failed to load manuscripts.');
    }
}

function renderManuscriptList() {
    const container = document.getElementById('manuscriptList');
    if (!container) return;
    if (!allManuscripts || allManuscripts.length === 0) {
        container.innerHTML = '<div class="empty-state">No manuscripts yet.</div>';
        return;
    }
    const cards = allManuscripts.map(m => {
        // Backend returns chapter_count + total_words on list; fall back to computing from chapters
        const chapters = m.chapters || [];
        const chapterCount = (typeof m.chapter_count === 'number') ? m.chapter_count : chapters.length;
        const totalWords = (typeof m.total_words === 'number')
            ? m.total_words
            : chapters.reduce((sum, c) => sum + (c.word_count || computeWordCount(c.content || '')), 0);
        const updated = m.updated_at ? new Date(m.updated_at).toLocaleString() : '—';
        return `
            <div class="manuscript-card" data-mid="${escapeHtml(m.id)}" onclick="openManuscript('${escapeHtml(m.id)}')">
                <div class="manuscript-card-title">${escapeHtml(m.title || 'Untitled')}</div>
                <div class="manuscript-card-meta">
                    <span>${chapterCount} chapter${chapterCount === 1 ? '' : 's'} · ${totalWords.toLocaleString()} words</span>
                    <span>${escapeHtml(updated)}</span>
                </div>
                <div class="manuscript-card-actions" onclick="event.stopPropagation()">
                    <button class="doc-action-btn" onclick="openManuscript('${escapeHtml(m.id)}')">Open</button>
                    <button class="doc-action-btn doc-delete-btn" onclick="deleteManuscript('${escapeHtml(m.id)}')">Delete</button>
                </div>
            </div>
        `;
    }).join('');
    container.innerHTML = cards;
}

async function createManuscript() {
    if (!requireProject()) return;
    const title = window.prompt('Manuscript title:');
    if (!title || !title.trim()) return;
    try {
        const resp = await fetch(projectUrl('/manuscripts'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title.trim() })
        });
        if (!resp.ok) throw new Error('create failed');
        const created = await resp.json();
        await loadManuscripts();
        const newId = created.id || (created.manuscript && created.manuscript.id);
        if (newId) openManuscript(newId);
    } catch (err) {
        addSystemMessage('Failed to create manuscript.');
    }
}

async function deleteManuscript(mid) {
    if (!confirm('Delete this manuscript and all its chapters?')) return;
    try {
        const resp = await fetch(projectUrl(`/manuscripts/${mid}`), { method: 'DELETE' });
        if (!resp.ok) throw new Error('delete failed');
        await loadManuscripts();
    } catch (err) {
        addSystemMessage('Failed to delete manuscript.');
    }
}

async function loadWritingStreak() {
    if (!currentProjectId) return;
    try {
        const resp = await fetch(projectUrl('/writing-streak'));
        if (!resp.ok) return;
        writingStreakData = await resp.json();
        const badge = document.getElementById('writingStreakBadge');
        if (badge) {
            const streak = writingStreakData.streak || 0;
            const todayWords = writingStreakData.today_words || 0;
            badge.innerHTML = `🔥 ${streak} day streak · ${todayWords.toLocaleString()} words today`;
        }
    } catch { /* ignore */ }
}

async function openManuscript(mid) {
    if (!requireProject()) return;
    try {
        const resp = await fetch(projectUrl(`/manuscripts/${mid}`));
        if (!resp.ok) throw new Error('Failed to load manuscript');
        const manuscript = await resp.json();
        currentManuscriptId = manuscript.id || mid;
        // stash full object locally so chapter ops can update it
        const idx = allManuscripts.findIndex(m => m.id === currentManuscriptId);
        if (idx >= 0) allManuscripts[idx] = manuscript;
        else allManuscripts.push(manuscript);

        const listView = document.getElementById('manuscriptListView');
        const editorView = document.getElementById('manuscriptEditorView');
        if (listView) listView.style.display = 'none';
        if (editorView) editorView.style.display = 'flex';

        const titleEl = document.getElementById('manuscriptTitle');
        if (titleEl) titleEl.textContent = manuscript.title || 'Untitled';

        if (!quillEditor) initQuillEditor();

        renderChapterList();

        const chapters = manuscript.chapters || [];
        if (chapters.length > 0) {
            openChapter(chapters[0].id);
        } else {
            currentChapterId = null;
            if (quillEditor) quillEditor.setContents([]);
            const wc = document.getElementById('manuscriptWordCount');
            if (wc) wc.textContent = 'No chapters — click + Add Chapter';
        }
    } catch (err) {
        addSystemMessage('Failed to open manuscript.');
    }
}

function closeManuscriptEditor() {
    const listView = document.getElementById('manuscriptListView');
    const editorView = document.getElementById('manuscriptEditorView');
    if (editorView) editorView.style.display = 'none';
    if (listView) listView.style.display = 'flex';
    currentManuscriptId = null;
    currentChapterId = null;
    loadManuscripts();
}

function _currentManuscript() {
    return allManuscripts.find(m => m.id === currentManuscriptId);
}

function renderChapterList() {
    const container = document.getElementById('chapterList');
    if (!container) return;
    const m = _currentManuscript();
    if (!m) { container.innerHTML = ''; return; }
    const chapters = m.chapters || [];
    if (chapters.length === 0) {
        container.innerHTML = '<div class="empty-state">No chapters yet.</div>';
        return;
    }
    container.innerHTML = chapters.map(c => {
        const active = c.id === currentChapterId ? 'active' : '';
        return `
            <div class="chapter-item ${active}" data-cid="${escapeHtml(c.id)}">
                <span class="chapter-title" onclick="openChapter('${escapeHtml(c.id)}')">${escapeHtml(c.title || 'Untitled')}</span>
                <button onclick="renameChapter('${escapeHtml(c.id)}')" title="Rename">✎</button>
                <button onclick="showVersionHistory('${escapeHtml(c.id)}')" title="History">⟲</button>
                <button onclick="deleteChapter('${escapeHtml(c.id)}')" title="Delete" class="danger">✕</button>
            </div>
        `;
    }).join('');
}

async function addChapter() {
    if (!currentManuscriptId) return;
    const title = window.prompt('Chapter title:');
    if (!title || !title.trim()) return;
    try {
        const resp = await fetch(projectUrl(`/manuscripts/${currentManuscriptId}/chapters`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title.trim() })
        });
        if (!resp.ok) throw new Error('add chapter failed');
        const created = await resp.json();
        const newChapter = created.chapter || created;
        const m = _currentManuscript();
        if (m) {
            m.chapters = m.chapters || [];
            m.chapters.push(newChapter);
        }
        renderChapterList();
        if (newChapter && newChapter.id) openChapter(newChapter.id);
    } catch (err) {
        addSystemMessage('Failed to add chapter.');
    }
}

async function openChapter(cid) {
    if (!currentManuscriptId) return;
    try {
        // Save current chapter first if switching
        if (currentChapterId && currentChapterId !== cid && quillEditor) {
            await saveCurrentChapter();
        }
        const m = _currentManuscript();
        let chapter = m && m.chapters ? m.chapters.find(c => c.id === cid) : null;
        if (!chapter) {
            // fetch from backend as fallback
            const resp = await fetch(projectUrl(`/manuscripts/${currentManuscriptId}/chapters/${cid}`));
            if (resp.ok) chapter = await resp.json();
        }
        if (!chapter) return;
        currentChapterId = cid;
        if (quillEditor) {
            quillEditor.root.innerHTML = chapter.content || '';
        }
        const wc = document.getElementById('manuscriptWordCount');
        if (wc) wc.textContent = `${computeWordCount(chapter.content || '')} words`;
        renderChapterList();
    } catch (err) {
        addSystemMessage('Failed to open chapter.');
    }
}

async function deleteChapter(cid) {
    if (!currentManuscriptId) return;
    if (!confirm('Delete this chapter?')) return;
    try {
        const resp = await fetch(projectUrl(`/manuscripts/${currentManuscriptId}/chapters/${cid}`), { method: 'DELETE' });
        if (!resp.ok) throw new Error('delete failed');
        const m = _currentManuscript();
        if (m && m.chapters) {
            m.chapters = m.chapters.filter(c => c.id !== cid);
        }
        if (currentChapterId === cid) {
            currentChapterId = null;
            if (quillEditor) quillEditor.setContents([]);
        }
        renderChapterList();
    } catch (err) {
        addSystemMessage('Failed to delete chapter.');
    }
}

async function renameChapter(cid) {
    if (!currentManuscriptId) return;
    const m = _currentManuscript();
    const existing = m && m.chapters ? m.chapters.find(c => c.id === cid) : null;
    const newTitle = window.prompt('New chapter title:', existing ? existing.title : '');
    if (!newTitle || !newTitle.trim()) return;
    try {
        const resp = await fetch(projectUrl(`/manuscripts/${currentManuscriptId}/chapters/${cid}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle.trim() })
        });
        if (!resp.ok) throw new Error('rename failed');
        if (existing) existing.title = newTitle.trim();
        renderChapterList();
    } catch (err) {
        addSystemMessage('Failed to rename chapter.');
    }
}

function initQuillEditor() {
    if (typeof Quill === 'undefined') {
        addSystemMessage('Quill editor not loaded.');
        return;
    }
    const editorEl = document.getElementById('quillEditor');
    const toolbarEl = document.getElementById('quillToolbar');
    if (!editorEl) return;

    quillEditor = new Quill('#quillEditor', {
        theme: 'snow',
        modules: {
            toolbar: {
                container: toolbarEl || [
                    [{ 'header': [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'blockquote'],
                    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                    ['link']
                ]
            }
        }
    });

    // Add custom Cite button if toolbar exists and doesn't already have one
    if (toolbarEl && !toolbarEl.querySelector('.ql-cite-custom')) {
        const citeBtn = document.createElement('button');
        citeBtn.type = 'button';
        citeBtn.className = 'ql-cite-custom';
        citeBtn.textContent = 'Cite';
        citeBtn.onclick = (e) => { e.preventDefault(); showCitationPicker(); };
        toolbarEl.appendChild(citeBtn);
    }

    quillEditor.on('text-change', () => {
        const html = quillEditor.root.innerHTML;
        const wc = document.getElementById('manuscriptWordCount');
        if (wc) wc.textContent = `${computeWordCount(html)} words`;
        if (_quillSaveTimer) clearTimeout(_quillSaveTimer);
        _quillSaveTimer = setTimeout(() => {
            saveCurrentChapter();
        }, 2000);
    });
}

async function saveCurrentChapter() {
    if (!currentManuscriptId || !currentChapterId || !quillEditor) return;
    const content = quillEditor.root.innerHTML;
    try {
        const resp = await fetch(projectUrl(`/manuscripts/${currentManuscriptId}/chapters/${currentChapterId}`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!resp.ok) throw new Error('save failed');
        const m = _currentManuscript();
        if (m && m.chapters) {
            const ch = m.chapters.find(c => c.id === currentChapterId);
            if (ch) {
                ch.content = content;
                ch.word_count = computeWordCount(content);
            }
        }
        loadWritingStreak();
    } catch (err) {
        // soft fail — don't spam
    }
}

function computeWordCount(html) {
    if (!html) return 0;
    const text = String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ');
    const tokens = text.split(/\s+/).filter(t => t.length > 0);
    return tokens.length;
}

async function showCitationPicker() {
    const modal = document.getElementById('citationPickerModal');
    const input = document.getElementById('citationPickerInput');
    const list = document.getElementById('citationPickerList');
    if (!modal || !list) return;

    modal.style.display = 'flex';
    list.innerHTML = '<div class="empty-state">Loading…</div>';

    // Try to load from a dedicated citations list endpoint; fall back to allDocs.
    let citations = [];
    try {
        const resp = await fetch(projectUrl('/citations'));
        if (resp.ok) {
            const data = await resp.json();
            citations = Array.isArray(data) ? data : (data.citations || []);
        }
    } catch { /* fall through */ }

    if (!citations.length && typeof allDocs !== 'undefined' && Array.isArray(allDocs)) {
        citations = allDocs
            .filter(d => d && (d.citation_key || d.bibtex || d.doi))
            .map(d => ({
                key: d.citation_key || d.id || d.filename,
                title: d.title || d.filename || d.name,
                authors: d.authors || [],
                year: d.year || (d.date ? String(d.date).slice(0, 4) : '')
            }));
    }

    _allCitationsCache = citations;
    _renderCitationPickerList(citations);

    if (input) {
        input.value = '';
        input.oninput = () => {
            const q = input.value.toLowerCase().trim();
            if (!q) { _renderCitationPickerList(_allCitationsCache); return; }
            const filtered = _allCitationsCache.filter(c => {
                const hay = `${c.key || ''} ${c.title || ''} ${(c.authors || []).join(' ')} ${c.year || ''}`.toLowerCase();
                return hay.includes(q);
            });
            _renderCitationPickerList(filtered);
        };
        input.focus();
    }
}

function _renderCitationPickerList(items) {
    const list = document.getElementById('citationPickerList');
    if (!list) return;
    if (!items || items.length === 0) {
        list.innerHTML = '<div class="empty-state">No citations found.</div>';
        return;
    }
    list.innerHTML = items.map(c => {
        const key = c.key || '';
        const authors = (c.authors || []).join(', ');
        const year = c.year || '';
        return `
            <div class="citation-picker-item">
                <div class="citation-info">
                    <div class="citation-title">${escapeHtml(c.title || key)}</div>
                    <div class="citation-meta">${escapeHtml(authors)} ${escapeHtml(year ? '(' + year + ')' : '')} · <code>${escapeHtml(key)}</code></div>
                </div>
                <button onclick="insertCitation('${escapeHtml(key)}')">Insert</button>
            </div>
        `;
    }).join('');
}

function closeCitationPicker() {
    const modal = document.getElementById('citationPickerModal');
    if (modal) modal.style.display = 'none';
}

function _shortCiteFromEntry(entry) {
    if (!entry) return '';
    let lastName = '';
    const authors = entry.authors || [];
    if (authors.length > 0) {
        const first = String(authors[0] || '');
        // handle "Last, First" and "First Last"
        if (first.includes(',')) lastName = first.split(',')[0].trim();
        else {
            const parts = first.trim().split(/\s+/);
            lastName = parts[parts.length - 1] || first;
        }
    }
    const year = entry.year || '';
    if (lastName && year) return `(${lastName}, ${year})`;
    if (lastName) return `(${lastName})`;
    if (year) return `(${year})`;
    return `(${entry.key || 'cite'})`;
}

async function insertCitation(key) {
    if (!quillEditor) return;
    const entry = _allCitationsCache.find(c => c.key === key);
    const shortCite = _shortCiteFromEntry(entry || { key });

    const range = quillEditor.getSelection(true);
    const insertAt = range ? range.index : quillEditor.getLength();
    quillEditor.insertText(insertAt, shortCite, 'user');
    quillEditor.setSelection(insertAt + shortCite.length, 0);

    // Track citation_used on the manuscript
    const m = _currentManuscript();
    if (m && currentManuscriptId) {
        m.citations_used = m.citations_used || [];
        if (!m.citations_used.includes(key)) {
            m.citations_used.push(key);
            try {
                await fetch(projectUrl(`/manuscripts/${currentManuscriptId}`), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ citations_used: m.citations_used })
                });
            } catch { /* ignore */ }
        }
    }
    closeCitationPicker();
}

async function showVersionHistory(cid) {
    const modal = document.getElementById('versionHistoryModal');
    const list = document.getElementById('versionHistoryList');
    if (!modal || !list) return;
    modal.style.display = 'flex';
    modal.dataset.cid = cid;
    list.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
        const resp = await fetch(projectUrl(`/versions/${cid}`));
        if (!resp.ok) throw new Error('failed');
        const data = await resp.json();
        const versions = Array.isArray(data) ? data : (data.versions || []);
        if (versions.length === 0) {
            list.innerHTML = '<div class="empty-state">No previous versions.</div>';
            return;
        }
        list.innerHTML = versions.map((v, idx) => {
            const ts = v.timestamp || v.created_at || v.saved_at || '';
            const tsStr = ts ? new Date(ts).toLocaleString() : '—';
            const wc = v.word_count != null ? v.word_count : computeWordCount(v.content || '');
            const safeContent = escapeHtml(String(v.content || '').replace(/<[^>]*>/g, ' ')).slice(0, 400);
            return `
                <div class="version-row">
                    <div class="version-meta">
                        <strong>${escapeHtml(tsStr)}</strong>
                        <span>${wc} words</span>
                    </div>
                    <div class="version-actions">
                        <button onclick="document.getElementById('versionPreview_${idx}').style.display='block'">Preview</button>
                        <button onclick="restoreVersion('${escapeHtml(cid)}', ${idx})">Restore</button>
                    </div>
                    <div id="versionPreview_${idx}" class="version-preview" style="display:none">${safeContent}</div>
                </div>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Failed to load versions.</div>';
    }
}

function closeVersionHistory() {
    const modal = document.getElementById('versionHistoryModal');
    if (modal) modal.style.display = 'none';
}

async function restoreVersion(cid, idx) {
    if (!confirm('Restore this version? Current content will be saved as a new version.')) return;
    try {
        const resp = await fetch(projectUrl(`/chapters/${cid}/restore`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version_index: idx })
        });
        if (!resp.ok) throw new Error('restore failed');
        closeVersionHistory();
        if (cid === currentChapterId) {
            // reload chapter content
            const r2 = await fetch(projectUrl(`/manuscripts/${currentManuscriptId}/chapters/${cid}`));
            if (r2.ok) {
                const ch = await r2.json();
                const m = _currentManuscript();
                if (m && m.chapters) {
                    const local = m.chapters.find(c => c.id === cid);
                    if (local) { local.content = ch.content; local.word_count = ch.word_count; }
                }
                if (quillEditor) quillEditor.root.innerHTML = ch.content || '';
                const wc = document.getElementById('manuscriptWordCount');
                if (wc) wc.textContent = `${computeWordCount(ch.content || '')} words`;
            }
        }
    } catch (err) {
        addSystemMessage('Failed to restore version.');
    }
}

function exportManuscript(mid, format) {
    if (!mid) mid = currentManuscriptId;
    if (!mid) return;
    window.open(projectUrl(`/manuscripts/${mid}/export?format=${encodeURIComponent(format)}`));
}

// ============================================================
// 21. Initialization
// ============================================================

// Wire up send button and enter key
if (sendBtn) sendBtn.onclick = sendQuestion;

if (questionInput) {
    questionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendQuestion();
        }
    });
}

// Auto-save note on blur
const noteContentInput = document.getElementById('noteContentInput');
const noteTitleInput = document.getElementById('noteTitleInput');
const noteTagsInput = document.getElementById('noteTagsInput');
if (noteContentInput) noteContentInput.addEventListener('blur', saveCurrentNote);
if (noteTitleInput) noteTitleInput.addEventListener('blur', saveCurrentNote);
if (noteTagsInput) noteTagsInput.addEventListener('blur', saveCurrentNote);

// BibTeX import file input
const bibtexFileInput = document.getElementById('bibtexFileInput');
if (bibtexFileInput) {
    bibtexFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !currentProjectId) return;
        const form = new FormData();
        form.append('file', file);
        try {
            const resp = await fetch(projectUrl('/bibtex/import'), { method: 'POST', body: form });
            const data = await resp.json();
            if (data.success) {
                addSystemMessage(`Imported ${data.imported} BibTeX entries.`);
            } else {
                addSystemMessage('BibTeX import failed: ' + (data.error || 'unknown'));
            }
        } catch (err) {
            addSystemMessage('BibTeX import failed: ' + err.message);
        }
        bibtexFileInput.value = '';
    });
}

// === BibTeX Export ===
async function exportBibtex() {
    if (!requireProject()) return;
    try {
        const resp = await fetch(projectUrl('/bibtex/export'));
        if (!resp.ok) {
            const err = await resp.json();
            addSystemMessage('Export failed: ' + (err.error || 'unknown'));
            return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bibliography.bib';
        a.click();
        URL.revokeObjectURL(url);
        addSystemMessage('Bibliography exported.');
    } catch (err) {
        addSystemMessage('Export failed: ' + err.message);
    }
}

// === DOI Lookup ===
function showDoiDialog() {
    if (!requireProject()) return;
    const dialog = document.getElementById('doiDialog');
    const input = document.getElementById('doiInput');
    const result = document.getElementById('doiResult');
    if (dialog) dialog.style.display = 'flex';
    if (input) { input.value = ''; input.focus(); }
    if (result) result.innerHTML = '';
}

function closeDoiDialog() {
    const dialog = document.getElementById('doiDialog');
    if (dialog) dialog.style.display = 'none';
}

async function fetchDoi() {
    if (!currentProjectId) return;
    const input = document.getElementById('doiInput');
    const result = document.getElementById('doiResult');
    const doi = (input?.value || '').trim();
    if (!doi) {
        if (result) result.innerHTML = '<span style="color:var(--red)">Please enter a DOI.</span>';
        return;
    }
    if (result) result.innerHTML = '<span class="spinner"></span> Looking up DOI...';

    try {
        const resp = await fetch(projectUrl('/citations/from-doi'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doi }),
        });
        const data = await resp.json();
        if (data.error) {
            if (result) result.innerHTML = `<span style="color:var(--red)">${escapeHtml(data.error)}</span>`;
            return;
        }
        const e = data.entry;
        const authorsStr = (e.authors || []).join(', ') || 'Unknown';
        if (result) {
            result.innerHTML = `
                <div style="padding:10px;background:var(--bg-tertiary);border-radius:var(--radius);border:1px solid var(--green);">
                    <div style="font-weight:600;color:var(--text);margin-bottom:4px;">${escapeHtml(e.title)}</div>
                    <div>${escapeHtml(authorsStr)} (${escapeHtml(e.year)})</div>
                    <div style="color:var(--text-muted);">${escapeHtml(e.source_info)}</div>
                </div>
                <div style="color:var(--green);margin-top:8px;">&#10003; Saved to citations.</div>
            `;
        }
        addSystemMessage(`Added DOI reference: ${e.title}`);
    } catch (err) {
        if (result) result.innerHTML = `<span style="color:var(--red)">Lookup failed: ${escapeHtml(err.message)}</span>`;
    }
}

// Start on project selection screen
showProjectScreen();
loadProjects();
checkHealth();
setInterval(checkHealth, 30000);
