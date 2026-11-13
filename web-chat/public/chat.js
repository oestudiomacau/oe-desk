(() => {
  const endpoint = `${String(window.OE_DESK_CHAT_API || '').replace(/\/$/, '')}/api/chat`;
  const messages = document.getElementById('messages');
  const welcome = document.getElementById('welcome');
  const composer = document.getElementById('composer');
  const question = document.getElementById('question');
  const send = document.getElementById('send');
  const clear = document.getElementById('clear');
  const status = document.getElementById('status');
  const history = [];
  let pending = null;
  let generation = 0;
  let retryQuestion = '';

  function scroll() { messages.scrollTop = messages.scrollHeight; }
  function autosize() { question.style.height = 'auto'; question.style.height = `${Math.min(130, Math.max(48, question.scrollHeight))}px`; }
  function addMessage(role, text) {
    welcome.hidden = true;
    const item = document.createElement('article'); item.className = `message ${role}`;
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? '您' : 'AI';
    const body = document.createElement('div');
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = role === 'user' ? '您' : 'OE DESK AI 客服';
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
    body.append(meta, bubble); item.append(avatar, body); messages.append(item); scroll();
    return item;
  }
  function setBusy(value) {
    send.textContent = value ? '停止' : '发送';
    send.setAttribute('aria-label', value ? '停止生成回复' : '发送问题');
    question.readOnly = value;
  }
  function showFailure(text) {
    status.replaceChildren(document.createTextNode(text));
    if (retryQuestion) {
      const button = document.createElement('button'); button.className = 'retry'; button.type = 'button'; button.textContent = '重试';
      button.addEventListener('click', () => ask(retryQuestion, true)); status.append(button);
    }
  }
  function stop() {
    if (!pending) return;
    generation += 1;
    pending.controller.abort(); pending.typing.remove(); pending = null; setBusy(false);
    retryQuestion = '';
    status.textContent = '已停止，可以继续提问。';
  }
  async function ask(text, retry = false) {
    const value = String(text || '').trim().slice(0, 1200);
    if (!value || pending) return;
    const id = ++generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 45000);
    status.textContent = ''; retryQuestion = value;
    if (!retry) { addMessage('user', value); history.push({ role: 'user', content: value }); }
    const typing = addMessage('assistant', '正在思考…');
    pending = { controller, typing }; setBusy(true); question.value = ''; autosize();
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: value, history: history.slice(0, -1).slice(-24) }), signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 429 ? '咨询较多，请稍等一分钟再试。' : payload.error || '客服暂时不可用。');
      const answer = String(payload.answer || '').trim().replace(/#{2,3}/g, '\n\n');
      if (!answer) throw new Error('暂时没有生成回复。');
      if (id !== generation) return;
      typing.remove(); addMessage('assistant', answer); history.push({ role: 'assistant', content: answer }); retryQuestion = '';
    } catch (error) {
      if (id !== generation) return;
      typing.remove(); showFailure(controller.signal.aborted ? '响应时间较长，请稍后重试。' : error instanceof TypeError ? '暂时无法连接客服，请检查网络后重试。' : error.message);
    } finally {
      clearTimeout(timer);
      if (id === generation) { pending = null; setBusy(false); question.focus(); }
    }
  }
  composer.addEventListener('submit', event => { event.preventDefault(); if (pending) stop(); else ask(question.value); });
  question.addEventListener('input', autosize);
  question.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); composer.requestSubmit(); }
  });
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
    if (pending) return; question.value = button.dataset.prompt; autosize(); question.focus();
  }));
  clear.addEventListener('click', () => {
    stop(); generation += 1; history.length = 0; retryQuestion = '';
    messages.replaceChildren(welcome); welcome.hidden = false; status.textContent = ''; question.value = ''; autosize(); question.focus();
  });
})();
