/* Pesles AI frontend
   Data-driven: conversations persist to localStorage and render from state.
   Chat streams over SSE; images open in a lightbox; video polls until done. */

const messagesEl = document.getElementById('messages');
const messageListEl = document.getElementById('messageList');
const welcomeEl = document.getElementById('welcome');
const inputEl = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const topbarTitle = document.getElementById('topbarTitle');
const suggestionsEl = document.getElementById('suggestions');
const recentsListEl = document.getElementById('recentsList');

/* ================= Persistent store ================= */

const STORE_KEY = 'jc_store_v1';
const MAX_CONVERSATIONS = 60;

function freshStore() {
  return { schemaVersion: 1, activeId: null, conversations: [] };
}

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!s || s.schemaVersion !== 1 || !Array.isArray(s.conversations)) return freshStore();
    s.conversations = s.conversations.filter(
      (c) => c && typeof c.id === 'string' && Array.isArray(c.messages)
    );
    return s;
  } catch {
    return freshStore();
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    // Only evict when the failure is actually the storage quota — otherwise
    // (private mode, storage disabled) dropping conversations gains nothing.
    const isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22);
    if (!isQuota) return;
    store.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    while (store.conversations.length > 1) {
      store.conversations.pop();
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        renderSidebar();
        return;
      } catch {}
    }
  }
}

let store = loadStore();
let activeId = null;
const modeParam = new URLSearchParams(location.search).get('mode');
let mode = modeParam || localStorage.getItem('jc_mode') || 'chat';
let busy = false;
let genToken = 0; // bumped on conversation switch to invalidate stale DOM updates
let editingMsgIndex = -1; // index in conv.messages being edited (-1 = none)

const uid = () => 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

function makeTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 50 ? t.slice(0, 47).replace(/\s+\S*$/, '') + '…' : t || 'New chat';
}

function getActive() {
  return store.conversations.find((c) => c.id === activeId) || null;
}

function ensureConversation(firstPrompt, convMode) {
  let conv = getActive();
  if (!conv) {
    conv = {
      id: uid(),
      title: makeTitle(firstPrompt),
      mode: convMode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    store.conversations.unshift(conv);
    // First message just created this conversation — give it its URL.
    history.replaceState(null, '', convUrl(conv.id));
    if (store.conversations.length > MAX_CONVERSATIONS) {
      // Evict the least-recently-updated conversation — never one that still
      // has a video generating, and never the one we just created.
      let oldest = null;
      for (const c of store.conversations) {
        if (c === conv) continue;
        if (c.messages.some((m) => m.status === 'pending')) continue;
        if (!oldest || c.updatedAt < oldest.updatedAt) oldest = c;
      }
      if (oldest) store.conversations = store.conversations.filter((c) => c !== oldest);
    }
    activeId = conv.id;
    store.activeId = conv.id; // persisted by the touch() that follows send()
  }
  return conv;
}

function touch(conv) {
  conv.updatedAt = Date.now();
  persist();
  renderSidebar();
}

/* ================= Modes ================= */

const MODES = {
  chat: {
    title: 'Chat',
    placeholder: 'Ask anything…',
    suggestions: [
      'Explain Bitcoin halving like I\'m five',
      'Write a Python script that tracks crypto prices',
      'Draft a tweet thread about DeFi trends in 2026',
      'What are the risks of leverage trading?',
    ],
  },
  image: {
    title: 'Image',
    placeholder: 'Describe an image — or attach one to transform it…',
    suggestions: [
      'A golden bitcoin rocket launching to the moon, cinematic 3D render',
      'Cyberpunk trading floor at night, neon charts, rain on windows',
      'Minimalist logo concept for a crypto startup, gold and black',
      'A futuristic city where buildings are made of blockchain cubes',
    ],
  },
  video: {
    title: 'Video',
    placeholder: 'Describe a video — or attach an image to animate it…',
    suggestions: [
      'A gold coin spinning in slow motion, studio lighting, macro shot',
      'Drone shot flying over a futuristic solar-powered city at sunrise',
      'A cat in a suit typing on a laptop in a trading office, cinematic',
      'Ocean waves crashing on a black sand beach at golden hour',
    ],
  },
};

/* ================= SVG / small helpers ================= */

const svgIcon = (id) => `<svg class="ico"><use href="#${id}"/></svg>`;
const TYPING = '<span class="typing"><i></i><i></i><i></i></span>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ChatGPT-style generation placeholder: a shimmering frame at the output's
// aspect ratio with the status (and progress bar, for video) overlaid on it.
// Accepts "16:9" and "1280x720" ratio forms; falls back to a square.
function mediaSkeletonHTML(kind, ratio, label, withTrack) {
  let [w, h] = String(ratio || '').split(/[:x]/).map(Number);
  if (!(w > 0) || !(h > 0)) [w, h] = [1, 1];
  // Landscape fills the bubble width; square and portrait get narrower frames
  // so the height stays reasonable.
  const px = w > h ? 420 : w === h ? 340 : Math.round(400 * (w / h));
  return (
    `<div class="media-skeleton" style="aspect-ratio:${w}/${h};width:min(100%,${px}px)">` +
    svgIcon(kind === 'video' ? 'i-video' : 'i-image') +
    '<div class="media-skeleton-status">' +
    `<div class="progress-line"><span class="pl-text">${label}</span>${TYPING}</div>` +
    (withTrack ? '<div class="progress-track"><div class="progress-fill"></div></div>' : '') +
    '</div></div>'
  );
}

// Unguessable id for chat-reply recovery (the server buffers replies by id).
const chatUid = () =>
  window.crypto?.randomUUID ? crypto.randomUUID() : uid() + '-' + Math.random().toString(36).slice(2, 10);

// Copy text to the clipboard with visual feedback on the button.
async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fallback for non-secure contexts (plain http).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (btn) {
    btn.innerHTML = svgIcon(ok ? 'i-check' : 'i-close');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = svgIcon('i-copy');
      btn.classList.remove('copied');
    }, 1400);
  }
}

// Backup guard: rewrite provider/model brand strings if the model ever leaks
// them despite the server-side identity prompt. Narrow on purpose — the bare
// word "Agnes" (e.g. a person's name) is never touched.
const BRAND_PATTERNS = [
  /agnes[-\s]?(?:2\.0|20|image[-\s]?2\.[01]|video[-\s]?v?2\.0)[-\s]?(?:flash)?/gi,
  /agnes\s?ai\b/gi,
  /agnes-ai\.com/gi,
  /sapiens\s?ai\b/gi,
  /apihub\.agnes-ai\.com/gi,
];
const scrubBrands = (text) => BRAND_PATTERNS.reduce((t, re) => t.replace(re, 'Pesles AI'), text);

/* ================= Markdown rendering =================
   Assistant replies arrive as Markdown. Everything is HTML-escaped BEFORE any
   tags are generated, and link hrefs are restricted to http(s), so model
   output can never inject markup. Covers: bold/italic/strike, inline code,
   fenced code blocks, headings, lists (one nesting level), blockquotes,
   links, tables, and horizontal rules. */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mdInlineFactory(inlineCodes) {
  return (s) => {
    s = escapeHtml(s);
    // Protect inline code from further formatting.
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      inlineCodes.push(`<code>${c}</code>`);
      return '<<I' + (inlineCodes.length - 1) + '>>';
    });
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    s = s.replace(/<<I(\d+)>>/g, (_, i) => inlineCodes[i]);
    return s;
  };
}

function mdBuildList(items, inline) {
  const topTag = items[0].ordered ? 'ol' : 'ul';
  let html = `<${topTag}>`;
  let idx = 0;
  while (idx < items.length) {
    const it = items[idx];
    if (it.depth === 0) {
      let inner = `<li>${inline(it.text)}`;
      idx++;
      const kids = [];
      while (idx < items.length && items[idx].depth === 1) kids.push(items[idx++]);
      if (kids.length) {
        const t = kids[0].ordered ? 'ol' : 'ul';
        inner += `<${t}>` + kids.map((k) => `<li>${inline(k.text)}</li>`).join('') + `</${t}>`;
      }
      html += inner + '</li>';
    } else {
      html += `<li>${inline(it.text)}</li>`;
      idx++;
    }
  }
  return html + `</${topTag}>`;
}

function renderMarkdown(src) {
  if (!src) return '';
  const codeBlocks = [];
  const inlineCodes = [];
  const inline = mdInlineFactory(inlineCodes);

  // Fenced code blocks first ("$" end alt. keeps an unclosed fence rendering
  // as code while a reply is still streaming).
  src = src.replace(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g, (_, code) => {
    codeBlocks.push(
      '<div class="code-wrap">' +
      `<button class="copy-btn code-copy" aria-label="Copy code" title="Copy code">${svgIcon('i-copy')}</button>` +
      `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`
    );
    // Own line always — a mid-line fence would otherwise get HTML-escaped
    // during inline processing and the block would never be restored.
    return '\n<<B' + (codeBlocks.length - 1) + '>>\n';
  });

  const liRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const hrRe = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
  const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l || '') && (l || '').includes('-');
  const cells = (l) =>
    l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()));

  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^<<B\d+>>$/.test(line.trim())) { out.push(line.trim()); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++; continue;
    }
    if (hrRe.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    if (liRe.test(line)) {
      const items = [];
      while (i < lines.length && liRe.test(lines[i])) {
        const [, ind, marker, txt] = lines[i].match(liRe);
        items.push({ depth: ind.length >= 2 ? 1 : 0, ordered: /^\d/.test(marker), text: txt });
        i++;
      }
      out.push(mdBuildList(items, inline));
      continue;
    }

    const para = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
      !liRe.test(lines[i]) && !hrRe.test(lines[i]) &&
      !/^<<B\d+>>$/.test(lines[i].trim()) &&
      !(lines[i].includes('|') && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('').replace(/<<B(\d+)>>/g, (_, n) => codeBlocks[n]);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setBusy(v) {
  busy = v;
  sendBtn.disabled = v;
}

async function readJsonError(res) {
  try {
    const data = await res.json();
    return data?.error?.message || 'Something went wrong. Please try again.';
  } catch {
    return 'Something went wrong. Please try again.';
  }
}

/* ================= Rendering ================= */

// Media always displays through the same-origin /api/media proxy. Older
// conversations may still hold direct provider URLs — wrap those at render
// time so they display and download the same way.
function normalizeMediaUrl(url) {
  if (!url) return url;
  if (url.startsWith('http')) return '/api/media?url=' + encodeURIComponent(url);
  return url; // already proxied, or a data: URI
}

// Proxied URLs get dl=1 so the server forces a real download with a filename.
// data: URIs download natively via the anchor's download attribute. Parses the
// url so both relative and browser-absolutized forms of /api/media are caught.
function downloadHref(url, filename) {
  try {
    const u = new URL(url, location.href);
    if (u.origin === location.origin && u.pathname === '/api/media') {
      return `${u.pathname}${u.search}&dl=1&name=${encodeURIComponent(filename)}`;
    }
  } catch {}
  return url;
}

const mediaFilename = (kind, ts) =>
  `pesles-${kind}-${new Date(ts || Date.now()).toISOString().slice(0, 10)}-${(ts || Date.now()) % 100000}.${kind === 'video' ? 'mp4' : 'png'}`;

/* Finished media loads inside the same shimmering frame the generation used —
   a refreshed conversation used to flash empty black players while the
   proxied file loaded. The frame holds the layout, the media fades in once
   it's actually ready, and videos capture a tiny poster on first load so the
   next reload shows a real frame instantly. */

function mediaFrameEl(kind, m, src, content) {
  const frame = document.createElement('div');
  frame.className = 'media-skeleton media-frame'; // same shimmer while loading
  let [w, h] = String(m.ratio || '').split(/[:x]/).map(Number);
  if (!(w > 0) || !(h > 0)) [w, h] = kind === 'video' ? [16, 9] : [1, 1];
  const size = () => {
    const px = w > h ? 420 : w === h ? 340 : Math.round(400 * (w / h));
    frame.style.aspectRatio = `${w} / ${h}`;
    frame.style.width = `min(100%, ${px}px)`;
  };
  size();
  frame.innerHTML = svgIcon(kind === 'video' ? 'i-video' : 'i-image');

  const ready = () => frame.classList.add('ready');
  // Older messages didn't store a ratio — snap the frame to the media's real
  // one before revealing, so nothing gets cropped by object-fit.
  const snap = (rw, rh) => {
    if (rw > 0 && rh > 0 && Math.abs(rw / rh - w / h) > 0.01) { w = rw; h = rh; size(); }
  };
  const expired = () => {
    content.innerHTML = `<span class="media-expired">${svgIcon(kind === 'video' ? 'i-video' : 'i-image')} This ${kind} is no longer available</span>`;
  };
  // Whatever happens, never shimmer forever — fall back to the bare element.
  setTimeout(ready, 12000);

  if (kind === 'video') {
    const video = document.createElement('video');
    video.className = 'gen-video';
    video.src = src;
    video.controls = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    if (m.poster) {
      // A real frame from this video, captured on a previous load — the
      // player looks finished immediately, no skeleton needed.
      video.poster = m.poster;
      video.preload = 'metadata';
      ready();
      video.addEventListener('loadedmetadata', () => snap(video.videoWidth, video.videoHeight), { once: true });
    } else {
      video.preload = 'auto'; // need the first frame for the reveal + poster
      video.addEventListener('loadeddata', () => {
        snap(video.videoWidth, video.videoHeight);
        ready();
        capturePoster(video, m);
      }, { once: true });
    }
    video.onerror = expired;
    frame.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.className = 'gen-image';
    img.src = src;
    img.alt = m.prompt || 'Generated image';
    img.dataset.filename = mediaFilename('image', m.ts);
    img.addEventListener('load', () => { snap(img.naturalWidth, img.naturalHeight); ready(); }, { once: true });
    img.onerror = expired;
    frame.appendChild(img);
  }
  return frame;
}

// One-time poster capture: draw the loaded first frame to a small canvas and
// persist it with the message. Same-origin media (proxy or /media) keeps the
// canvas untainted; if anything refuses, the poster is only a nicety.
function capturePoster(video, m) {
  if (m.poster || !video.videoWidth) return;
  try {
    const scale = Math.min(1, 480 / video.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(video.videoWidth * scale));
    c.height = Math.max(1, Math.round(video.videoHeight * scale));
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    m.poster = c.toDataURL('image/jpeg', 0.65);
    persist();
  } catch { /* tainted canvas / storage full — skip silently */ }
}

function renderMessageEl(m) {
  const msg = document.createElement('div');
  msg.className = `msg ${m.role}`;

  const body = document.createElement('div');
  body.className = 'msg-body';
  const content = document.createElement('div');
  content.className = 'msg-content';
  body.appendChild(content);
  msg.appendChild(body);

  if (m.type === 'text') {
    // Attached images/files render as thumbnails and chips above the text.
    if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
      const row = document.createElement('div');
      row.className = 'msg-attachments';
      m.attachments.forEach((a) => {
        if (a.kind === 'image' && a.thumb) {
          const img = document.createElement('img');
          img.className = 'att-img';
          img.src = a.thumb;
          img.alt = a.name || 'Attached image';
          row.appendChild(img);
        } else {
          const chip = document.createElement('span');
          chip.className = 'att-file';
          chip.innerHTML = svgIcon(a.kind === 'image' ? 'i-image' : 'i-file');
          chip.appendChild(document.createTextNode(a.name || 'file'));
          row.appendChild(chip);
        }
      });
      content.appendChild(row);
    }
    if (m.status === 'streaming') {
      // In-flight reply — persisted so a refresh can recover it. The sender
      // (or recoverChat) finds this element by data-chat-id to live-update it.
      msg.dataset.chatId = m.chatId || '';
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = renderMarkdown(m.content || '');
      content.appendChild(md);
      content.insertAdjacentHTML('beforeend', TYPING);
    } else if (m.status === 'failed') {
      const err = document.createElement('div');
      err.className = 'msg-error';
      err.innerHTML = svgIcon('i-alert');
      const span = document.createElement('span');
      span.textContent = m.errorText || 'This reply was interrupted — please ask again.';
      err.appendChild(span);
      content.appendChild(err);
    } else if (m.content) {
      if (m.role === 'assistant') {
        // Assistant replies are Markdown — render them formatted.
        const md = document.createElement('div');
        md.className = 'md';
        md.innerHTML = renderMarkdown(m.content);
        content.appendChild(md);
        // Copy-reply button (copies the raw text, like ChatGPT).
        const row = document.createElement('div');
        row.className = 'msg-copy-row';
        const btn = document.createElement('button');
        btn.className = 'copy-btn msg-copy';
        btn.setAttribute('aria-label', 'Copy reply');
        btn.title = 'Copy';
        btn.innerHTML = svgIcon('i-copy');
        btn.addEventListener('click', () => copyText(m.content, btn));
        row.appendChild(btn);
        // Fake like / dislike buttons (no backend)
        const likeBtn = document.createElement('button');
        likeBtn.className = 'copy-btn msg-like';
        likeBtn.setAttribute('aria-label', 'Like');
        likeBtn.title = 'Like';
        likeBtn.innerHTML = svgIcon('i-thumbs-up');
        likeBtn.addEventListener('click', () => toggleFeedback(likeBtn, dislikeBtn, 'like'));
        row.appendChild(likeBtn);
        const dislikeBtn = document.createElement('button');
        dislikeBtn.className = 'copy-btn msg-dislike';
        dislikeBtn.setAttribute('aria-label', 'Dislike');
        dislikeBtn.title = 'Dislike';
        dislikeBtn.innerHTML = svgIcon('i-thumbs-down');
        dislikeBtn.addEventListener('click', () => toggleFeedback(dislikeBtn, likeBtn, 'dislike'));
        row.appendChild(dislikeBtn);
        body.appendChild(row);
      } else {
        content.appendChild(document.createTextNode(m.content));
        // Copy + Edit buttons on user messages
        const row = document.createElement('div');
        row.className = 'msg-copy-row';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn msg-copy';
        copyBtn.setAttribute('aria-label', 'Copy message');
        copyBtn.title = 'Copy';
        copyBtn.innerHTML = svgIcon('i-copy');
        copyBtn.addEventListener('click', () => copyText(m.content, copyBtn));
        row.appendChild(copyBtn);
        const editBtn = document.createElement('button');
        editBtn.className = 'copy-btn msg-edit';
        editBtn.setAttribute('aria-label', 'Edit message');
        editBtn.title = 'Edit';
        editBtn.innerHTML = svgIcon('i-edit');
        editBtn.addEventListener('click', () => startEdit(m, body));
        row.appendChild(editBtn);
        msg.appendChild(row);
      }
    }
  } else if (m.type === 'image') {
    if (m.status === 'pending') {
      // Persisted in-progress generation — survives a refresh. The sender
      // (or recoverImage) finds this element by data-image-id to finish it.
      msg.dataset.imageId = m.imageId || '';
      content.innerHTML = mediaSkeletonHTML(
        'image',
        m.ratio,
        m.i2i ? 'Transforming your image' : 'Creating your image',
        false
      );
    } else if (m.status === 'failed') {
      const err = document.createElement('div');
      err.className = 'msg-error';
      err.innerHTML = svgIcon('i-alert');
      const span = document.createElement('span');
      span.textContent = m.errorText || 'This image couldn’t be generated — please try again.';
      err.appendChild(span);
      content.appendChild(err);
    } else if (m.url) {
      const src = normalizeMediaUrl(m.url);
      content.appendChild(mediaFrameEl('image', m, src, content));
      content.appendChild(mediaActions(src, 'Download image', mediaFilename('image', m.ts)));
    } else {
      content.innerHTML = `<span class="media-expired">${svgIcon('i-image')} This image is no longer available</span>`;
    }
  } else if (m.type === 'video') {
    if (m.status === 'pending') {
      // Persisted in-progress task — a background poller (pollVideoTask)
      // finds this element by data-video-id and updates it.
      msg.dataset.videoId = m.videoId || '';
      content.innerHTML = mediaSkeletonHTML('video', m.ratio, 'Generating your video', true);
    } else if (m.status === 'failed') {
      content.innerHTML = `<span class="media-expired">${svgIcon('i-video')} This video couldn’t be generated</span>`;
    } else if (m.url) {
      const src = normalizeMediaUrl(m.url);
      content.appendChild(mediaFrameEl('video', m, src, content));
      content.appendChild(mediaActions(src, 'Download video', mediaFilename('video', m.ts)));
    } else {
      content.innerHTML = `<span class="media-expired">${svgIcon('i-video')} This video is no longer available</span>`;
    }
  }
  return msg;
}

function mediaActions(url, label, filename) {
  const actions = document.createElement('div');
  actions.className = 'media-actions';
  const a = document.createElement('a');
  a.href = downloadHref(url, filename);
  a.download = filename;
  a.innerHTML = svgIcon('i-download');
  a.appendChild(document.createTextNode(label));
  actions.appendChild(a);
  return actions;
}

function appendMessage(m) {
  welcomeEl.style.display = 'none';
  const el = renderMessageEl(m);
  messageListEl.appendChild(el);
  scrollToBottom();
  return el.querySelector('.msg-content');
}

// Transient assistant row (typing / progress) — not part of persisted state.
function appendTransient(innerHTML) {
  welcomeEl.style.display = 'none';
  const msg = document.createElement('div');
  msg.className = 'msg assistant transient';
  msg.innerHTML = `<div class="msg-body"><div class="msg-content">${innerHTML}</div></div>`;
  messageListEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

function replaceTransient(node, m) {
  const el = renderMessageEl(m);
  node.replaceWith(el);
  scrollToBottom();
}

function showTransientError(node, message) {
  const content = node.querySelector('.msg-content');
  content.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.innerHTML = svgIcon('i-alert');
  const span = document.createElement('span');
  span.textContent = message;
  div.appendChild(span);
  content.appendChild(div);
}

function renderConversation() {
  messageListEl.innerHTML = '';
  const conv = getActive();
  if (!conv || conv.messages.length === 0) {
    welcomeEl.style.display = '';
    renderSuggestions();
    return;
  }
  welcomeEl.style.display = 'none';
  conv.messages.forEach((m) => {
    // One malformed message (e.g. from an older version of the app) must
    // never blank the rest of the conversation or stop the resume logic.
    try {
      messageListEl.appendChild(renderMessageEl(m));
    } catch (err) {
      console.error('Failed to render a message:', err);
    }
  });
  scrollToBottom();
}

function renderSuggestions() {
  suggestionsEl.innerHTML = '';
  MODES[mode].suggestions.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = s;
    b.addEventListener('click', () => {
      inputEl.value = s;
      send();
    });
    suggestionsEl.appendChild(b);
  });
}

/* ================= Sidebar: recents ================= */

function groupLabel(ts) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - day) return 'Yesterday';
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days';
  if (ts >= startOfToday - 30 * day) return 'Previous 30 days';
  const d = new Date(ts);
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleString('en', { month: 'long' })
    : String(d.getFullYear());
}

function renderSidebar() {
  recentsListEl.innerHTML = '';
  const sorted = [...store.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  let lastLabel = null;

  sorted.forEach((conv) => {
    const label = groupLabel(conv.updatedAt);
    if (label !== lastLabel) {
      lastLabel = label;
      const h = document.createElement('div');
      h.className = 'recents-label';
      h.textContent = label;
      recentsListEl.appendChild(h);
    }

    const row = document.createElement('div');
    row.className = 'recent-item' + (conv.id === activeId ? ' active' : '');

    const btn = document.createElement('a');
    btn.className = 'recent-title';
    btn.href = convUrl(conv.id);
    btn.textContent = conv.title;
    btn.title = conv.title;
    btn.addEventListener('click', (e) => {
      // Modified clicks (open in new tab, copy link) keep native behavior.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigateTo(conv.id);
      closeSidebar();
    });

    // Delete: first click arms (icon becomes a red check), second confirms.
    const del = document.createElement('button');
    del.className = 'recent-delete';
    del.setAttribute('aria-label', 'Delete chat');
    del.innerHTML = svgIcon('i-trash');
    let armed = false;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add('armed');
        del.innerHTML = svgIcon('i-check');
        setTimeout(() => {
          armed = false;
          del.classList.remove('armed');
          del.innerHTML = svgIcon('i-trash');
        }, 2600);
        return;
      }
      store.conversations = store.conversations.filter((c) => c.id !== conv.id);
      persist();
      if (activeId === conv.id) {
        navigateTo(null, { push: false }); // deleted the open chat — go home
      } else {
        renderSidebar();
      }
    });

    row.appendChild(btn);
    row.appendChild(del);
    recentsListEl.appendChild(row);
  });
}

/* ================= Sidebar drawer ================= */

const sidebarEl = document.getElementById('sidebar');
const backdropEl = document.getElementById('backdrop');
const openSidebar = () => {
  sidebarEl.classList.add('open');
  backdropEl.classList.add('show');
};
const closeSidebar = () => {
  sidebarEl.classList.remove('open');
  backdropEl.classList.remove('show');
};
document.getElementById('sidebarClose').addEventListener('click', () => {
  maybeOpenPromo('jc_promo_ts_sidebarclose');
  closeSidebar();
});
backdropEl.addEventListener('click', closeSidebar);

/* ---- Desktop sidebar hide/show (mobile uses the drawer) ---- */

const appEl = document.querySelector('.app');
const SIDEBAR_KEY = 'jc_sidebar_hidden';
const isDesktop = () => window.matchMedia('(min-width: 1025px)').matches;

function setSidebarHidden(hidden) {
  appEl.classList.toggle('sidebar-collapsed', hidden);
  try { localStorage.setItem(SIDEBAR_KEY, hidden ? '1' : '0'); } catch {}
}
setSidebarHidden(localStorage.getItem(SIDEBAR_KEY) === '1');

document.getElementById('sidebarCollapse').addEventListener('click', () => {
  maybeOpenPromo('jc_promo_ts_sidebarhide');
  setSidebarHidden(true);
});
document.getElementById('hamburger').addEventListener('click', () => {
  // Desktop: the hamburger reopens the collapsed sidebar; mobile: opens drawer.
  if (isDesktop()) setSidebarHidden(false);
  else openSidebar();
});

/* ---- Dark / light theme ---- */

const themeToggle = document.getElementById('themeToggle');
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const THEME_KEY = 'jc_theme';

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeColorMeta.setAttribute('content', t === 'light' ? '#f7f7f8' : '#0a0b0d');
  themeToggle.innerHTML = svgIcon(t === 'light' ? 'i-moon' : 'i-sun');
  themeToggle.title = t === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
}
let theme = localStorage.getItem(THEME_KEY) || 'dark';
applyTheme(theme);

themeToggle.addEventListener('click', () => {
  maybeOpenPromo('jc_promo_ts_theme');
  theme = theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  applyTheme(theme);
});

/* ================= Conversation links =================
   Every conversation has its own URL (/c/<id>): refresh keeps your place,
   back/forward navigate between chats, and history items are real links.
   Conversations live in this browser's storage, so a link opens the
   conversation on this device. */

const convUrl = (id) => {
  if (!id) return '/';
  const conv = store.conversations.find((c) => c.id === id);
  const prefix = conv?.mode === 'image' ? '/img/' : conv?.mode === 'video' ? '/vid/' : '/c/';
  return prefix + id;
};

function navigateTo(id, { push = true } = {}) {
  if (location.pathname !== convUrl(id)) {
    history[push ? 'pushState' : 'replaceState'](null, '', convUrl(id));
  }
  if (id === activeId) return;
  activeId = id;
  store.activeId = id; // remembered so a refresh restores this conversation
  persist();
  genToken++;
  renderConversation();
  renderSidebar();
}

function routeFromUrl() {
  const m = location.pathname.match(/^\/(c|img|vid)\/([\w-]+)$/);
  return m && store.conversations.some((c) => c.id === m[2]) ? m[2] : null;
}

window.addEventListener('popstate', () => {
  const id = routeFromUrl();
  if (id !== activeId) {
    activeId = id;
    store.activeId = id;
    persist();
    genToken++;
    renderConversation();
    renderSidebar();
  }
});

/* ================= Mode switching ================= */

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    maybeOpenPromo('jc_promo_ts_mode_' + btn.dataset.mode);
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      e.preventDefault();
      window.open('/?mode=' + btn.dataset.mode, '_blank');
      return;
    }
    mode = btn.dataset.mode;
    try { localStorage.setItem('jc_mode', mode); } catch {}
    document.querySelectorAll('.mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode)
    );
    topbarTitle.textContent = MODES[mode].title;
    inputEl.placeholder = MODES[mode].placeholder;
    document.getElementById('imageOptions').classList.toggle('hidden', mode !== 'image');
    document.getElementById('videoOptions').classList.toggle('hidden', mode !== 'video');
    // Text files only make sense in chat; images carry over to any mode.
    if (mode !== 'chat' && attachments.some((a) => a.kind === 'file')) {
      attachments = attachments.filter((a) => a.kind === 'image');
      renderAttachStrip();
    }
    renderSuggestions();
    closeSidebar();
    inputEl.focus();
  });
});

document.getElementById('newChatBtn').addEventListener('click', (e) => {
  maybeOpenPromo('jc_promo_ts_newchat');
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    e.preventDefault();
    window.open('/', '_blank');
    return;
  }
  navigateTo(null);
  closeSidebar();
  inputEl.focus();
});

/* ================= Message actions ================= */

function toggleFeedback(btn, other, kind) {
  const active = btn.classList.toggle('active');
  other.classList.remove('active');
}

function startEdit(msg, bodyEl) {
  const conv = getActive();
  if (!conv) return;
  const idx = conv.messages.indexOf(msg);
  if (idx === -1) return;
  editingMsgIndex = idx;

  const msgEl = bodyEl.closest('.msg');
  const contentEl = bodyEl.querySelector('.msg-content');
  contentEl.dataset.originalHtml = contentEl.innerHTML;

  let html = '';

  // Show attachments if present
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    html += '<div class="edit-attachments">';
    msg.attachments.forEach((a) => {
      if (a.kind === 'image' && a.thumb) {
        html +=
          `<div class="edit-attach-chip"><img src="${escapeHtml(a.thumb)}" alt="${escapeHtml(a.name || '')}"><span>${escapeHtml(a.name || 'image')}</span></div>`;
      } else {
        html +=
          `<div class="edit-attach-chip">${svgIcon('i-file')}<span>${escapeHtml(a.name || 'file')}</span></div>`;
      }
    });
    html += '</div>';
  }

  html +=
    `<textarea class="edit-textarea">${escapeHtml(msg.content)}</textarea>` +
    `<div class="edit-actions">` +
    `<button class="edit-btn edit-save">Save & Resend</button>` +
    `<button class="edit-btn edit-cancel">Cancel</button></div>`;

  contentEl.innerHTML = html;

  const copyRow = msgEl.querySelector('.msg-copy-row');
  if (copyRow) copyRow.style.display = 'none';

  const ta = contentEl.querySelector('.edit-textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  contentEl.querySelector('.edit-save').addEventListener('click', () => finishEdit(ta.value, msg));
  contentEl.querySelector('.edit-cancel').addEventListener('click', () => cancelEdit(contentEl, copyRow));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finishEdit(ta.value, msg); }
  });

  msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function finishEdit(newText, origMsg) {
  if (editingMsgIndex < 0 || !newText.trim()) return;
  const conv = getActive();
  if (!conv) return;

  const origMode = origMsg.mode || 'chat';
  const origAttData = runtimeAtt.get(origMsg);

  // Truncate conversation from the edited message onwards
  conv.messages.splice(editingMsgIndex);
  const els = messageListEl.querySelectorAll('.msg');
  for (let i = editingMsgIndex; i < els.length; i++) els[i].remove();
  editingMsgIndex = -1;

  // Build the new user message reusing original attachments
  const userMsg = { role: 'user', type: 'text', content: newText, mode: origMode, ts: Date.now() };
  if (origAttData && origAttData.length) {
    userMsg.attachments = origAttData.map((a) => ({ kind: a.kind, name: a.name, thumb: a.thumb || null }));
    runtimeAtt.set(userMsg, origAttData);
  }
  conv.messages.push(userMsg);
  appendMessage(userMsg);
  touch(conv);

  // Call the appropriate send function based on the original mode
  if (origMode === 'chat') sendChat(conv, userMsg);
  else if (origMode === 'image') sendImage(conv, userMsg);
  else sendVideo(conv, userMsg);
}

function cancelEdit(contentEl, copyRow) {
  contentEl.innerHTML = contentEl.dataset.originalHtml || '';
  if (copyRow) copyRow.style.display = '';
  editingMsgIndex = -1;
}

/* ================= Composer ================= */

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);

/* ================= Attachments ================= */

const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachStrip = document.getElementById('attachStrip');
const attachErrorEl = document.getElementById('attachError');
const composerBox = document.querySelector('.composer-box');

const MAX_ATTACH = 4;
const MAX_TEXT_FILE = 200 * 1024; // per text file, keeps chat context sane
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|ts|jsx|tsx|py|rb|go|rs|java|c|h|cpp|cs|php|sql|sh|bat|ps1|html|css|xml|yml|yaml|toml|ini|log)$/i;

// Chat accepts images (vision) + plain-text files; image & video modes
// accept images only (image-to-image / image-to-video).
const ATTACH_ACCEPT = {
  chat: 'image/*,.txt,.md,.markdown,.csv,.tsv,.json,.js,.mjs,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.sql,.sh,.bat,.ps1,.html,.css,.xml,.yml,.yaml,.toml,.ini,.log',
  image: 'image/*',
  video: 'image/*',
};

let attachments = []; // {kind:'image'|'file', name, dataUrl?, text?, thumb?}

// Full-size attachment data lives here for the session only — messages
// persist just {kind, name, thumb} so localStorage never fills with base64.
const runtimeAtt = new WeakMap();

let attachErrTimer = null;
function attachError(msg) {
  attachErrorEl.textContent = msg;
  attachErrorEl.hidden = false;
  clearTimeout(attachErrTimer);
  attachErrTimer = setTimeout(() => { attachErrorEl.hidden = true; }, 4000);
}

function renderAttachStrip() {
  attachStrip.innerHTML = '';
  attachStrip.hidden = attachments.length === 0;
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.thumb;
      img.alt = a.name;
      chip.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'attach-file-ico';
      ic.innerHTML = svgIcon('i-file');
      chip.appendChild(ic);
    }
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = a.name;
    name.title = a.name;
    chip.appendChild(name);
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.setAttribute('aria-label', 'Remove attachment');
    rm.innerHTML = svgIcon('i-close');
    rm.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachStrip();
    });
    chip.appendChild(rm);
    attachStrip.appendChild(chip);
  });
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function drawScaled(img, maxDim, mime, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#fff'; // transparent PNGs get a white base, not black
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(mime, quality);
}

// Downscale before upload: full size capped at 2048px (PNG keeps
// transparency unless huge), plus a tiny thumb that is safe to persist.
async function processImageFile(file) {
  const img = await fileToImage(file);
  const isPng = file.type === 'image/png';
  let dataUrl = drawScaled(img, 2048, isPng ? 'image/png' : 'image/jpeg', 0.85);
  if (dataUrl.length > 5_000_000) dataUrl = drawScaled(img, 2048, 'image/jpeg', 0.85);
  const thumb = drawScaled(img, 160, 'image/jpeg', 0.72);
  return { kind: 'image', name: file.name || 'image', dataUrl, thumb };
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (attachments.length >= MAX_ATTACH) {
      attachError(`Up to ${MAX_ATTACH} attachments per message.`);
      break;
    }
    if (file.type.startsWith('image/')) {
      try {
        attachments.push(await processImageFile(file));
      } catch {
        attachError(`Couldn’t read “${file.name}” — try a JPG or PNG.`);
        continue;
      }
    } else if (mode === 'chat' && (file.type.startsWith('text/') || TEXT_EXT.test(file.name))) {
      if (file.size > MAX_TEXT_FILE) {
        attachError(`“${file.name}” is too large (max 200 KB for text files).`);
        continue;
      }
      attachments.push({ kind: 'file', name: file.name, text: await file.text() });
    } else {
      attachError(
        mode === 'chat'
          ? 'Only images and text files can be attached.'
          : 'Only images can be attached here.'
      );
      continue;
    }
    renderAttachStrip();
  }
}

attachBtn.addEventListener('click', () => {
  fileInput.accept = ATTACH_ACCEPT[mode];
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

// Paste an image straight into the prompt box.
inputEl.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// Drag & drop onto the composer.
['dragenter', 'dragover'].forEach((ev) =>
  composerBox.addEventListener(ev, (e) => {
    e.preventDefault();
    composerBox.classList.add('dragover');
  })
);
composerBox.addEventListener('dragleave', () => composerBox.classList.remove('dragover'));
composerBox.addEventListener('drop', (e) => {
  e.preventDefault();
  composerBox.classList.remove('dragover');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* ================= Send flows ================= */

function send() {
  const prompt = inputEl.value.trim();
  if (busy) return;
  if (!prompt && attachments.length === 0) return;
  if (!prompt && mode !== 'chat') {
    attachError('Add a short description of what to create with your image.');
    return;
  }
  inputEl.value = '';
  inputEl.style.height = 'auto';

  const att = attachments;
  attachments = [];
  renderAttachStrip();

  const conv = ensureConversation(prompt || (att[0] && att[0].name) || 'New chat', mode);
  const userMsg = { role: 'user', type: 'text', content: prompt, mode, ts: Date.now() };
  if (att.length) {
    // Persist only names + tiny thumbs; the full-size data stays in memory.
    userMsg.attachments = att.map((a) => ({ kind: a.kind, name: a.name, thumb: a.thumb || null }));
    runtimeAtt.set(userMsg, att);
  }
  conv.messages.push(userMsg);
  appendMessage(userMsg);
  touch(conv);

  if (mode === 'chat') sendChat(conv, userMsg);
  else if (mode === 'image') sendImage(conv, userMsg);
  else sendVideo(conv, userMsg);
}

/* ----- Chat (SSE streaming) ----- */

async function sendChat(conv, userMsg) {
  setBusy(true);
  const convId = conv.id;
  const chatId = chatUid();

  // LLM context: only finalized chat-mode text turns (in-flight and failed
  // replies are skipped). User turns with in-memory attachments become
  // multimodal content: text files inlined, images as image_url blocks.
  const context = conv.messages
    .filter((m) => m.type === 'text' && !m.status && (m.role === 'assistant' || m.mode === 'chat'))
    .map((m) => {
      if (m.role !== 'user') return { role: m.role, content: m.content };
      const att = runtimeAtt.get(m) || [];
      let text = m.content || '';
      for (const f of att.filter((a) => a.kind === 'file')) {
        text += `\n\n[Attached file: ${f.name}]\n${f.text}`;
      }
      const images = att.filter((a) => a.kind === 'image' && a.dataUrl);
      if (images.length) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: text || 'Describe the attached image(s).' },
            ...images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } })),
          ],
        };
      }
      return { role: 'user', content: text };
    });

  // Persisted from the very start — a refresh mid-reply keeps whatever has
  // arrived, and recoverChat() fetches the rest from the server's buffer.
  const streamMsg = {
    role: 'assistant',
    type: 'text',
    status: 'streaming',
    chatId,
    content: '',
    mode: 'chat',
    ts: Date.now(),
  };
  conv.messages.push(streamMsg);
  touch(conv);
  appendMessage(streamMsg);

  let liveEl = null;
  const paint = () => {
    if (!liveEl || !liveEl.isConnected) {
      const el = chatMsgEl(convId, chatId);
      liveEl = el ? el.querySelector('.msg-content') : null;
    }
    if (!liveEl) return;
    liveEl.innerHTML =
      `<div class="md">${renderMarkdown(scrubBrands(fullText))}</div>` +
      '<span class="cursor-blink">▍</span>';
    scrollToBottom();
  };

  let fullText = '';
  let lastSave = Date.now();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: context, chat_id: chatId }),
    });

    if (!res.ok) {
      streamMsg.status = 'failed';
      streamMsg.errorText = await readJsonError(res);
      persist();
      replaceChatEl(convId, streamMsg);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const consumeFrame = (frame) => {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta =
            json?.choices?.[0]?.delta?.content ??
            json?.choices?.[0]?.message?.content ??
            '';
          if (delta) {
            fullText += delta;
            paint();
            if (Date.now() - lastSave > 1500) {
              streamMsg.content = scrubBrands(fullText);
              persist();
              lastSave = Date.now();
            }
          }
        } catch {
          /* ignore malformed keep-alive frames */
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      frames.forEach(consumeFrame);
    }
    if (buffer.trim()) consumeFrame(buffer);

    fullText = scrubBrands(fullText);
    if (fullText) {
      streamMsg.content = fullText;
      delete streamMsg.status;
      touch(conv);
      replaceChatEl(convId, streamMsg);
    } else {
      // Nothing arrived on this connection — the server buffer may have it.
      recoverChat(convId, streamMsg);
    }
  } catch (err) {
    console.error(err);
    streamMsg.content = scrubBrands(fullText);
    persist();
    recoverChat(convId, streamMsg); // connection died — try the server's copy
  } finally {
    setBusy(false);
  }
}

/* ----- Chat reply recovery (refresh / dropped connection) ----- */

function chatMsgEl(convId, chatId) {
  if (activeId !== convId || !chatId) return null;
  return messageListEl.querySelector(`.msg[data-chat-id="${CSS.escape(chatId)}"]`);
}

function replaceChatEl(convId, msg) {
  const el = chatMsgEl(convId, msg.chatId);
  if (el) el.replaceWith(renderMessageEl(msg));
}

// Poll the server's reply buffer until the reply is complete, updating the
// persisted message (and the screen, when its conversation is open).
async function recoverChat(convId, msg) {
  if (msg.status !== 'streaming') return;
  if (msg.chatId) {
    const deadline = Date.now() + 2 * 60 * 1000;
    let misses = 0;
    while (Date.now() < deadline && msg.status === 'streaming') {
      const conv = store.conversations.find((c) => c.id === convId);
      if (!conv || !conv.messages.includes(msg)) return; // conv deleted
      let data = null;
      try {
        const r = await fetch(`/api/chat/replay/${encodeURIComponent(msg.chatId)}`);
        if (r.status === 404) {
          // Unknown reply — tolerate a couple in case the request is still in
          // flight; a server restart makes this permanent, so then give up.
          if (++misses >= 3) break;
        } else if (r.ok) {
          misses = 0;
          data = await r.json();
        }
      } catch {}
      if (data) {
        if (data.text) {
          const text = scrubBrands(data.text);
          if (text !== msg.content) {
            msg.content = text;
            persist(); // another refresh during recovery keeps this progress
          }
          const el = chatMsgEl(convId, msg.chatId);
          const c = el && el.querySelector('.msg-content');
          if (c) {
            c.innerHTML = `<div class="md">${renderMarkdown(msg.content)}</div>` + TYPING;
          }
        }
        if (data.done) break;
      }
      await sleep(1500);
    }
  }
  finalizeChat(convId, msg);
}

function finalizeChat(convId, msg) {
  if (msg.status !== 'streaming') return;
  if (msg.content) delete msg.status; // keep what we have — it's the reply
  else msg.status = 'failed';
  persist();
  replaceChatEl(convId, msg);
}

// On page load: pick up any reply that was still streaming at last refresh.
function resumePendingChats() {
  const MAX_AGE = 10 * 60 * 1000; // matches the server's replay buffer TTL
  for (const conv of store.conversations) {
    for (const m of conv.messages) {
      if (m.type !== 'text' || m.status !== 'streaming') continue;
      if (!m.chatId || Date.now() - m.ts > MAX_AGE) finalizeChat(conv.id, m);
      else recoverChat(conv.id, m);
    }
  }
}

/* ----- Image generation (single-shot + refresh recovery) -----
   The generation is persisted as a 'pending' assistant message before the
   request is even sent, so a refresh can't lose it — the server parks the
   finished result under the same id, and recoverImage() fetches it. */

const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
const activeImagePolls = new Set(); // imageIds currently being recovered

async function sendImage(conv, userMsg) {
  setBusy(true);
  const convId = conv.id;
  const imageId = chatUid();
  const prompt = userMsg.content;
  const images = (runtimeAtt.get(userMsg) || [])
    .filter((a) => a.kind === 'image' && a.dataUrl)
    .map((a) => a.dataUrl);

  // Persisted from the start — a refresh mid-generation shows this bubble
  // again, and resumePendingImages() picks the finished result up.
  const pendingMsg = {
    role: 'assistant',
    type: 'image',
    status: 'pending',
    imageId,
    i2i: images.length > 0,
    ratio: document.getElementById('imgRatio').value, // sizes the skeleton
    prompt,
    mode: 'image',
    ts: Date.now(),
  };
  conv.messages.push(pendingMsg);
  touch(conv);
  appendMessage(pendingMsg);

  try {
    const res = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        size: document.getElementById('imgSize').value,
        ratio: document.getElementById('imgRatio').value,
        image_id: imageId,
        ...(images.length ? { image: images } : {}),
      }),
    });

    if (!res.ok) {
      finishImage(convId, pendingMsg, { status: 'failed', errorText: await readJsonError(res) });
      return;
    }
    applyImageResult(convId, pendingMsg, await res.json());
  } catch (err) {
    console.error(err);
    recoverImage(convId, pendingMsg); // connection died — the server finishes the job
  } finally {
    setBusy(false);
  }
}

// Find the on-screen element for a pending image, if its conversation is the
// active one. Re-queried on demand — renderConversation() rebuilds the DOM.
function pendingImageEl(convId, imageId) {
  if (activeId !== convId || !imageId) return null;
  return messageListEl.querySelector(`.msg[data-image-id="${CSS.escape(imageId)}"]`);
}

function finishImage(convId, msg, patch) {
  if (msg.status !== 'pending') return;
  delete msg.status;
  Object.assign(msg, patch); // may set status back to 'failed'
  const conv = store.conversations.find((c) => c.id === convId);
  if (conv) conv.updatedAt = Date.now();
  persist();
  renderSidebar();
  const el = pendingImageEl(convId, msg.imageId);
  if (el) el.replaceWith(renderMessageEl(msg));
}

function applyImageResult(convId, msg, data) {
  if (data.url) {
    finishImage(convId, msg, { url: data.url });
  } else if (data.b64_json) {
    // Volatile base64 (local save failed server-side) — persist url:null,
    // but show the image for this session via a throwaway data: URI copy.
    if (msg.status !== 'pending') return;
    const el = pendingImageEl(convId, msg.imageId);
    delete msg.status;
    msg.url = null;
    const conv = store.conversations.find((c) => c.id === convId);
    if (conv) conv.updatedAt = Date.now();
    persist();
    renderSidebar();
    if (el) el.replaceWith(renderMessageEl({ ...msg, url: `data:image/png;base64,${data.b64_json}` }));
  } else {
    finishImage(convId, msg, { status: 'failed' });
  }
}

// Poll the server for a finished image whose response this page lost
// (refresh or dropped connection), then finalize the persisted message.
async function recoverImage(convId, msg) {
  if (msg.status !== 'pending' || !msg.imageId || activeImagePolls.has(msg.imageId)) return;
  activeImagePolls.add(msg.imageId);
  try {
    let misses = 0;
    while (Date.now() - msg.ts < IMAGE_TIMEOUT_MS && msg.status === 'pending') {
      // Conversation deleted while we waited? Stop quietly.
      const conv = store.conversations.find((c) => c.id === convId);
      if (!conv || !conv.messages.includes(msg)) return;
      let data = null;
      try {
        const r = await fetch(`/api/image/result/${encodeURIComponent(msg.imageId)}`);
        if (r.status === 404) {
          // Unknown job — tolerate a couple in case the request is still in
          // flight; a server restart makes this permanent, so then give up.
          if (++misses >= 3) break;
        } else if (r.ok) {
          misses = 0;
          data = await r.json();
        }
      } catch {}
      if (data && data.done) {
        if (data.error) return finishImage(convId, msg, { status: 'failed', errorText: data.error });
        return applyImageResult(convId, msg, data);
      }
      await sleep(2500);
    }
    if (msg.status === 'pending') finishImage(convId, msg, { status: 'failed' });
  } finally {
    activeImagePolls.delete(msg.imageId);
  }
}

// On page load: pick up any image that was still generating at last refresh.
function resumePendingImages() {
  let dirty = false;
  for (const conv of store.conversations) {
    for (const m of conv.messages) {
      if (m.type !== 'image' || m.status !== 'pending') continue;
      if (!m.imageId || Date.now() - m.ts > IMAGE_TIMEOUT_MS) {
        m.status = 'failed';
        dirty = true;
        continue;
      }
      recoverImage(conv.id, m);
    }
  }
  if (dirty) {
    persist();
    renderConversation();
  }
}

/* ----- Video generation (create + background poll) -----
   The task is persisted as a 'pending' assistant message the moment it's
   created, so a page refresh can't lose it — on load, resumePendingVideos()
   picks every pending task back up and polling continues where it left off. */

const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
const activePolls = new Set(); // videoIds currently being polled (dedup guard)

async function sendVideo(conv, userMsg) {
  setBusy(true);
  const token = genToken;
  const prompt = userMsg.content;
  const images = (runtimeAtt.get(userMsg) || [])
    .filter((a) => a.kind === 'image' && a.dataUrl)
    .map((a) => a.dataUrl);
  const startLabel = images.length ? 'Animating your image' : 'Starting your video';
  const [width, height] = document.getElementById('vidSize').value.split('x').map(Number);
  const node = appendTransient(mediaSkeletonHTML('video', `${width}x${height}`, startLabel, true));

  try {
    const res = await fetch('/api/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        num_frames: Number(document.getElementById('vidFrames').value),
        frame_rate: 24,
        width,
        height,
        // 1 image → image-to-video; 2+ → keyframe animation (server decides).
        ...(images.length ? { image: images } : {}),
      }),
    });

    if (!res.ok) {
      showTransientError(node, await readJsonError(res));
      return;
    }

    const task = await res.json();
    if (!task.video_id) {
      showTransientError(node, 'Video generation couldn’t start. Please try again.');
      return;
    }

    // Persist the in-progress task NOW — this is what survives a refresh.
    const pendingMsg = {
      role: 'assistant',
      type: 'video',
      status: 'pending',
      videoId: task.video_id,
      ratio: `${width}x${height}`, // sizes the skeleton frame
      prompt,
      mode: 'video',
      ts: Date.now(),
    };
    conv.messages.push(pendingMsg);
    touch(conv);
    if (token === genToken) replaceTransient(node, pendingMsg);
    pollVideoTask(conv.id, pendingMsg);
  } catch (err) {
    console.error(err);
    if (token === genToken) showTransientError(node, 'Video generation failed. Please try again.');
  } finally {
    // Composer frees up as soon as the task is queued — polling runs in the
    // background, so the user can keep chatting while the video renders.
    setBusy(false);
  }
}

// Find the on-screen element for a pending video, if its conversation is the
// active one. Re-queried every tick: renderConversation() rebuilds the DOM on
// every switch, so holding node references across awaits would go stale.
function pendingVideoEl(convId, videoId) {
  if (activeId !== convId) return null;
  return messageListEl.querySelector(`.msg[data-video-id="${CSS.escape(videoId)}"]`);
}

async function pollVideoTask(convId, msg) {
  if (!msg.videoId || activePolls.has(msg.videoId)) return;
  activePolls.add(msg.videoId);

  const finish = (patch) => {
    Object.assign(msg, patch);
    const conv = store.conversations.find((c) => c.id === convId);
    if (conv) conv.updatedAt = Date.now();
    persist();
    renderSidebar();
    const el = pendingVideoEl(convId, msg.videoId);
    if (el) el.replaceWith(renderMessageEl(msg));
  };

  try {
    // Deadline anchors to the task's creation time, not this poller's start,
    // so a refresh doesn't reset the 15-minute clock.
    while (Date.now() - msg.ts < VIDEO_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 5000));

      // Conversation deleted (or evicted) while we waited? Stop quietly.
      const conv = store.conversations.find((c) => c.id === convId);
      if (!conv || !conv.messages.includes(msg)) return;

      let poll, status;
      try {
        poll = await fetch(`/api/video/${encodeURIComponent(msg.videoId)}`);
      } catch {
        continue; // network blip — keep polling
      }
      if (!poll.ok) {
        // Only "task gone" is terminal; rate limits and hiccups are retried.
        if (poll.status === 404) return finish({ status: 'failed' });
        continue;
      }
      try {
        status = await poll.json();
      } catch {
        continue;
      }

      const el = pendingVideoEl(convId, msg.videoId);
      if (el) {
        const pct = Math.max(0, Math.min(100, Number(status.progress) || 0));
        const label = status.status === 'queued' ? 'Waiting in queue' : 'Generating your video';
        const line = el.querySelector('.pl-text');
        const fill = el.querySelector('.progress-fill');
        if (line) line.textContent = `${label} — ${pct}%`;
        if (fill) fill.style.width = pct + '%';
      }

      if (status.status === 'completed') {
        if (status.url) return finish({ status: 'done', url: status.url });
        return finish({ status: 'failed' }); // completed but no playable result
      }
      if (status.status === 'failed') {
        if (status.error) console.error(status.error);
        return finish({ status: 'failed' });
      }
    }
    finish({ status: 'failed' }); // timed out — never leave 'pending' forever
  } finally {
    activePolls.delete(msg.videoId);
  }
}

// On page load: resume polling every video that was still generating when the
// page was last closed or refreshed.
function resumePendingVideos() {
  let dirty = false;
  for (const conv of store.conversations) {
    for (const m of conv.messages) {
      if (m.type !== 'video' || m.status !== 'pending') continue;
      if (!m.videoId || Date.now() - m.ts > VIDEO_TIMEOUT_MS) {
        m.status = 'failed';
        dirty = true;
        continue;
      }
      pollVideoTask(conv.id, m);
    }
  }
  if (dirty) {
    persist();
    renderConversation();
  }
}

/* ================= Lightbox ================= */

const lightboxEl = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxDownload = document.getElementById('lightboxDownload');
const lightboxClose = document.getElementById('lightboxClose');
let lightboxReturnFocus = null;

function openLightbox(src, alt, filename) {
  lightboxReturnFocus = document.activeElement;
  lightboxImg.src = src;
  lightboxImg.alt = alt || 'Generated image';
  const name = filename || mediaFilename('image');
  lightboxDownload.href = downloadHref(src, name);
  lightboxDownload.download = name;
  lightboxEl.hidden = false;
  document.documentElement.classList.add('lb-open');
  requestAnimationFrame(() => lightboxEl.classList.add('show'));
  lightboxClose.focus();
}

function closeLightbox() {
  lightboxEl.classList.remove('show');
  document.documentElement.classList.remove('lb-open');
  const done = () => {
    lightboxEl.hidden = true;
    lightboxImg.src = '';
    lightboxEl.removeEventListener('transitionend', done);
  };
  lightboxEl.addEventListener('transitionend', done);
  setTimeout(done, 300); // fallback if transitionend never fires
  if (lightboxReturnFocus?.focus) lightboxReturnFocus.focus();
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxEl.addEventListener('click', (e) => {
  if (e.target === lightboxEl) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxEl.hidden) closeLightbox();
});

// Delegated: every generated image (live or restored from history) is clickable.
// getAttribute (not .src) keeps the url relative — .src absolutizes it, which
// would defeat downloadHref's same-origin proxy check.
messageListEl.addEventListener('click', (e) => {
  // Code-block copy buttons live inside re-rendered markdown, so they're
  // handled here by delegation rather than per-render listeners.
  const codeBtn = e.target.closest('.code-copy');
  if (codeBtn) {
    const code = codeBtn.closest('.code-wrap')?.querySelector('code');
    if (code) copyText(code.innerText, codeBtn);
    return;
  }
  const img = e.target.closest('img.gen-image');
  if (img) openLightbox(img.getAttribute('src'), img.alt, img.dataset.filename);
});

/* ================= Sponsored links (optional) =================
   When the server injects window.__promoUrls (PROMO_URL env var — one or
   more comma-separated links), clicking New Chat or switching modes opens
   one of them, picked at random, in a new tab — at most once per 30 min per
   button, so regular users aren't nagged on every action. */

function maybeOpenPromo(key) {
  if (!Array.isArray(window.__promoUrls) || !window.__promoUrls.length) return;
  const PROMO_COOLDOWN = 30 * 60 * 1000;
  let last = 0;
  try { last = Number(localStorage.getItem(key)) || 0; } catch {}
  if (Date.now() - last < PROMO_COOLDOWN) return;
  try { localStorage.setItem(key, String(Date.now())); } catch {}
  const url = window.__promoUrls[Math.floor(Math.random() * window.__promoUrls.length)];
  try { window.open(url, '_blank', 'noopener'); } catch {}
}

// Any click on the page can also trigger a promo (own 30-min cooldown).
document.addEventListener('pointerdown', () => { maybeOpenPromo('jc_promo_ts_general'); }, true);

/* ================= Init ================= */

activeId = routeFromUrl(); // restore the conversation the URL points at
if (!activeId && /^\/(c|img|vid)\//.test(location.pathname)) {
  history.replaceState(null, '', '/'); // dead link (deleted chat) — clean up
} else if (!activeId && store.conversations.some((c) => c.id === store.activeId)) {
  // URL doesn't name a conversation — reopen the last one that was open, so
  // a refresh never loses your place (also covers chats from before /c/ links).
  activeId = store.activeId;
  history.replaceState(null, '', convUrl(activeId));
}
// Sync mode from query param / localStorage to the UI
document.querySelectorAll('.mode-btn').forEach((b) =>
  b.classList.toggle('active', b.dataset.mode === mode)
);
topbarTitle.textContent = MODES[mode].title;
inputEl.placeholder = MODES[mode].placeholder;
document.getElementById('imageOptions').classList.toggle('hidden', mode !== 'image');
document.getElementById('videoOptions').classList.toggle('hidden', mode !== 'video');

renderSuggestions();
renderSidebar();
renderConversation();
try { resumePendingVideos(); } catch (err) { console.error(err); }
try { resumePendingChats(); } catch (err) { console.error(err); }
try { resumePendingImages(); } catch (err) { console.error(err); }
