// Dhakira Dashboard

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  turns: [],
  currentPage: 'conversations',
  selectedTurn: null,
  profileContent: '',
  status: null,
  searchQuery: '',
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const res = await fetch(path, opts)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ─── Toast ───────────────────────────────────────────────────────────────────

let toastTimer = null

function showToast(msg, type = '') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = `toast${type ? ` ${type}` : ''}`
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.classList.add('hidden')
  }, 3000)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso) {
  if (!iso || iso === 'null') return 'never'
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    const months = Math.floor(days / 30)
    return `${months}mo ago`
  } catch {
    return iso
  }
}

function formatDate(iso) {
  if (!iso || iso === 'null') return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

function formatDateTime(iso) {
  if (!iso || iso === 'null') return 'never'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(str, len) {
  if (!str) return ''
  return str.length > len ? str.slice(0, len).trimEnd() + '…' : str
}

/** Escape text then wrap query matches in <mark class="hl">. */
function highlightText(text, query) {
  const escaped = escapeHtml(text)
  if (!query) return escaped
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped.replace(new RegExp(safe, 'gi'), '<mark class="hl">$&</mark>')
}

function toolBadge(tool) {
  const toolLower = (tool || '').toLowerCase()
  let cls = 'other'
  if (toolLower.includes('claude')) cls = 'claude'
  else if (toolLower.includes('cursor')) cls = 'cursor'
  else if (toolLower.includes('openai') || toolLower.includes('gpt')) cls = 'openai'
  return `<span class="badge badge-tool badge-tool-${cls}">${escapeHtml(truncate(tool || 'unknown', 16))}</span>`
}

// ─── Date grouping ────────────────────────────────────────────────────────────

function getDateGroupLabel(iso) {
  if (!iso || iso === 'null') return 'Unknown'
  try {
    const d = new Date(iso)
    const now = new Date()
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const diffDays = Math.round((todayMidnight - dMidnight) / 86400000)

    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
    if (diffDays < 365) return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  } catch {
    return 'Unknown'
  }
}

function groupTurnsByDate(turns) {
  const groups = []
  const seen = new Map()
  for (const turn of turns) {
    const label = getDateGroupLabel(turn.timestamp)
    if (!seen.has(label)) {
      const group = { label, turns: [] }
      seen.set(label, group)
      groups.push(group)
    }
    seen.get(label).turns.push(turn)
  }
  return groups
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigateTo(page) {
  state.currentPage = page
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === page)
  })
  document.querySelectorAll('.page').forEach((el) => {
    el.classList.toggle('active', el.id === `page-${page}`)
  })
  if (page === 'conversations') loadTurns()
  if (page === 'profile') loadProfile()
  if (page === 'settings') loadSettings()
}

// ─── Conversations ────────────────────────────────────────────────────────────

async function loadTurns() {
  try {
    const turns = await api('GET', '/api/turns')
    state.turns = turns
    const badge = document.getElementById('conversations-count')
    badge.textContent = String(turns.length)
    renderTurns()
  } catch (err) {
    document.getElementById('conversations-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4M12 16h.01"/>
          </svg>
        </div>
        <div class="empty-state-title">Failed to load</div>
        <div class="empty-state-body">${escapeHtml(err.message)}</div>
      </div>`
  }
}

function filteredTurns() {
  if (!state.searchQuery) return state.turns
  const q = state.searchQuery.toLowerCase()
  return state.turns.filter(
    (t) =>
      t.userContent.toLowerCase().includes(q) ||
      t.assistantContent.toLowerCase().includes(q) ||
      (t.tool || '').toLowerCase().includes(q),
  )
}

function renderTurns() {
  const list = document.getElementById('conversations-list')
  const turns = filteredTurns()

  // Update search result count
  const countEl = document.getElementById('search-count')
  if (state.searchQuery && countEl) {
    countEl.textContent = `${turns.length} result${turns.length === 1 ? '' : 's'}`
    countEl.classList.remove('hidden')
  } else if (countEl) {
    countEl.classList.add('hidden')
  }

  if (!turns.length) {
    const isSearch = Boolean(state.searchQuery)
    list.innerHTML = isSearch
      ? `<div class="empty-state">
          <div class="empty-state-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
          </div>
          <div class="empty-state-title">No results</div>
          <div class="empty-state-body">No turns match "${escapeHtml(state.searchQuery)}".</div>
        </div>`
      : `<div class="empty-state">
          <div class="empty-state-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="empty-state-title">No turns captured yet</div>
          <div class="empty-state-body">Point your AI tool at the proxy and start a conversation.</div>
          <div class="empty-state-code">localhost:4100</div>
        </div>`
    return
  }

  const groups = groupTurnsByDate(turns)

  list.innerHTML = groups
    .map(
      (group, gi) => `
        <div class="turn-group" style="--delay: ${gi * 45}ms">
          <div class="turn-group-header">${escapeHtml(group.label)}</div>
          ${group.turns
            .map(
              (t, ti) => `
            <div class="turn-row" data-id="${escapeHtml(t.id)}" style="--delay: ${gi * 45 + ti * 18 + 20}ms">
              <div class="turn-row-badge">${toolBadge(t.tool)}</div>
              <div class="turn-row-text">${highlightText(truncate(t.userContent, 150), state.searchQuery)}</div>
              <div class="turn-row-time">${formatRelativeTime(t.timestamp)}</div>
            </div>
          `,
            )
            .join('')}
        </div>
      `,
    )
    .join('')

  list.querySelectorAll('.turn-row').forEach((row) => {
    row.addEventListener('click', () => openTurnModal(row.dataset.id))
  })
}

function openTurnModal(id) {
  const turn = state.turns.find((t) => t.id === id)
  if (!turn) return
  state.selectedTurn = turn

  document.getElementById('modal-title').textContent = `Turn #${turn.turnIndex}`
  document.getElementById('modal-subtitle').textContent =
    `${turn.tool || 'unknown'} · ${formatDateTime(turn.timestamp)}`

  document.getElementById('modal-body').innerHTML = `
    <div class="conv-block">
      <div class="conv-role user-role">You</div>
      <div class="conv-content">${escapeHtml(turn.userContent || '(empty)')}</div>
    </div>
    <div class="conv-block">
      <div class="conv-role">Assistant</div>
      <div class="conv-content">${escapeHtml(turn.assistantContent || '(empty)')}</div>
    </div>
    <div class="modal-meta">
      <div class="modal-meta-item">
        <div class="field-label">Session</div>
        <div class="detail-value mono">${escapeHtml(turn.sessionId)}</div>
      </div>
      <div class="modal-meta-item">
        <div class="field-label">Turn ID</div>
        <div class="detail-value mono">${escapeHtml(turn.id)}</div>
      </div>
    </div>
  `

  document.getElementById('turn-modal').classList.remove('hidden')
}

function closeTurnModal() {
  document.getElementById('turn-modal').classList.add('hidden')
  state.selectedTurn = null
}

// ─── Profile ──────────────────────────────────────────────────────────────────

async function loadProfile() {
  try {
    const data = await api('GET', '/api/profile')
    state.profileContent = data.content || ''
    const editor = document.getElementById('profile-editor')
    editor.value = state.profileContent
    updateProfilePreview(state.profileContent)
  } catch {
    showToast('Something went wrong. Try again.', 'error')
  }
}

function updateProfilePreview(content) {
  const preview = document.getElementById('profile-preview-text')
  preview.textContent = content || '(empty — no profile set)'
}

async function saveProfile() {
  const content = document.getElementById('profile-editor').value
  try {
    await api('PUT', '/api/profile', { content })
    state.profileContent = content
    showToast('Saved.', 'success')
  } catch {
    showToast('Something went wrong. Try again.', 'error')
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const status = await api('GET', '/api/status')
    state.status = status
    renderStatus(status)
    const toggle = document.getElementById('incognito-toggle')
    toggle.checked = status.incognito
    document.getElementById('incognito-label').textContent = status.incognito
      ? 'Dhakira is paused'
      : 'Dhakira is active'
    updateStatusDot(status.incognito)
  } catch {
    showToast('Something went wrong. Try again.', 'error')
  }
}

function renderStatus(status) {
  const turns = status.turnCount ?? 0
  const sessions = status.sessionCount ?? 0
  const lastCapture = status.lastCaptureAt
    ? `Last capture ${formatRelativeTime(status.lastCaptureAt)}`
    : 'Never captured'

  const turnsLine =
    turns === 0
      ? 'No turns captured yet.'
      : `${turns} turn${turns === 1 ? '' : 's'} across ${sessions} session${sessions === 1 ? '' : 's'}`

  document.getElementById('status-content').innerHTML = `
    <div class="status-sentence">${escapeHtml(turnsLine)}</div>
    <div class="status-meta">${escapeHtml(lastCapture)}</div>
    <div class="status-item" style="margin-top:6px">
      <div class="status-label">Wallet</div>
      <div class="status-value mono">${escapeHtml(status.walletDir)}</div>
    </div>
  `
}

function updateStatusDot(incognito) {
  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-dot-label')
  if (!dot || !label) return
  if (incognito) {
    dot.className = 'status-dot'
    label.textContent = 'Paused'
  } else {
    dot.className = 'status-dot active'
    label.textContent = 'Listening'
  }
}

async function toggleIncognito(enabled) {
  try {
    await api('POST', '/api/incognito', { enabled })
    document.getElementById('incognito-label').textContent = enabled
      ? 'Dhakira is paused'
      : 'Dhakira is active'
    const indicator = document.getElementById('incognito-indicator')
    indicator.classList.toggle('hidden', !enabled)
    updateStatusDot(enabled)
    showToast(enabled ? 'Paused.' : 'Active.', 'success')
  } catch {
    const toggle = document.getElementById('incognito-toggle')
    toggle.checked = !enabled
    showToast('Something went wrong. Try again.', 'error')
  }
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function init() {
  // Navigation
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      navigateTo(el.dataset.page)
    })
  })

  // Search
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value
    renderTurns()
  })

  // / shortcut to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTurnModal()
      return
    }
    if (
      e.key === '/' &&
      state.currentPage === 'conversations' &&
      document.activeElement?.tagName !== 'INPUT' &&
      document.activeElement?.tagName !== 'TEXTAREA'
    ) {
      e.preventDefault()
      document.getElementById('search-input').focus()
    }
  })

  // Turn modal
  document.getElementById('modal-close').addEventListener('click', closeTurnModal)
  document.getElementById('modal-cancel').addEventListener('click', closeTurnModal)
  document.getElementById('turn-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTurnModal()
  })

  // Profile
  document.getElementById('save-profile').addEventListener('click', saveProfile)
  document.getElementById('profile-editor').addEventListener('input', (e) => {
    updateProfilePreview(e.target.value)
  })

  // Settings
  document.getElementById('incognito-toggle').addEventListener('change', (e) => {
    toggleIncognito(e.target.checked)
  })

  // Boot
  loadTurns()
  api('GET', '/api/status')
    .then((s) => {
      if (s.incognito) {
        document.getElementById('incognito-indicator').classList.remove('hidden')
      }
      updateStatusDot(s.incognito)
    })
    .catch(() => {})
}

document.addEventListener('DOMContentLoaded', init)
