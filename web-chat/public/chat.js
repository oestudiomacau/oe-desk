(() => {
  const api = String(window.OE_DESK_CHAT_API || '').replace(/\/$/, '');
  const endpoint = `${api}/api/chat`;
  const messages = document.getElementById('messages');
  const welcome = document.getElementById('welcome');
  const composer = document.getElementById('composer');
  const question = document.getElementById('question');
  const send = document.getElementById('send');
  const clear = document.getElementById('clear');
  const status = document.getElementById('status');
  const training = document.getElementById('training-panel');
  const trainingForm = document.getElementById('training-form');
  const trainingTurn = document.getElementById('training-turn');
  const trainingState = document.getElementById('training-state');
  const trainingOriginal = document.getElementById('training-original');
  const trainingOriginalGroup = document.getElementById('training-original-group');
  const trainingQuestion = document.getElementById('training-question');
  const trainingAnswer = document.getElementById('training-answer');
  const trainingResult = document.getElementById('training-result');
  const trainingSubmit = document.getElementById('training-submit');
  const history = [];
  const turns = new Map();
  const createDraft = (text = '') => ({ question: text, answer: '', original: '', state: '', result: '', saving: false });
  let manualDraft = createDraft();
  let latestTurn;
  let visibleDraft;
  let pending = null;
  let generation = 0;
  let retryQuestion = '';

  function renderTraining() {
    visibleDraft = trainingTurn.value === 'latest' ? latestTurn : trainingTurn.value === 'manual' ? manualDraft : turns.get(trainingTurn.value);
    const nextQuestion = visibleDraft?.question || '';
    const nextAnswer = visibleDraft?.answer || '';
    if (trainingQuestion.value !== nextQuestion) trainingQuestion.value = nextQuestion;
    if (trainingAnswer.value !== nextAnswer) trainingAnswer.value = nextAnswer;
    trainingQuestion.disabled = trainingAnswer.disabled = !visibleDraft;
    trainingQuestion.readOnly = trainingAnswer.readOnly = Boolean(visibleDraft?.saving);
    trainingSubmit.disabled = !visibleDraft || visibleDraft.saving;
    trainingOriginalGroup.hidden = !visibleDraft?.original;
    trainingOriginal.textContent = visibleDraft?.original || '';
    trainingResult.textContent = visibleDraft?.result || '';
    trainingState.textContent = visibleDraft?.state || (visibleDraft ? '' : '发送问题后，这里会显示 AI 的回复。');
  }
  trainingTurn.addEventListener('change', renderTraining);
  trainingForm.addEventListener('input', event => {
    if (!visibleDraft) return;
    if (event.target === trainingAnswer) visibleDraft.answerEdited = true;
    visibleDraft.question = trainingQuestion.value;
    visibleDraft.answer = trainingAnswer.value;
    visibleDraft.result = trainingResult.textContent = '';
  });

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
    document.getElementById('training-test').disabled = value;
  }
  function showFailure(text) {
    status.replaceChildren(document.createTextNode(text));
    if (retryQuestion) {
      const button = document.createElement('button'); button.className = 'retry'; button.type = 'button'; button.textContent = '重试';
      button.addEventListener('click', () => ask(retryQuestion, true)); status.append(button);
    }
  }
  function cancel(request) {
    if (!request.receipt) return;
    void fetch(`${endpoint}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.receipt), keepalive: true
    }).catch(() => {});
  }
  function stop() {
    if (!pending) return;
    generation += 1;
    pending.controller.abort(); cancel(pending); pending.typing.remove(); pending = null; setBusy(false);
    latestTurn.state = '已停止生成，可以填写训练答复。';
    if (visibleDraft === latestTurn) renderTraining();
    retryQuestion = '';
    status.textContent = '已停止，可以继续提问。';
  }
  async function ask(text, retry = false) {
    const value = String(text || '').trim().slice(0, 1200);
    if (!value || pending) return;
    const id = ++generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 150000);
    status.textContent = ''; retryQuestion = value;
    if (!retry) {
      addMessage('user', value);
      history.push({ role: 'user', content: value });
      latestTurn = createDraft(value.slice(0, 600));
      const key = String(id);
      latestTurn.key = key;
      turns.set(key, latestTurn);
      trainingTurn.append(new Option(`${turns.size}. ${value.slice(0, 55)}`, key));
    }
    const turn = latestTurn;
    turn.state = 'AI 正在生成回复…';
    if (trainingTurn.value === 'latest' || visibleDraft === turn) renderTraining();
    const typing = addMessage('assistant', '正在思考…');
    const request = { controller, typing, receipt: null };
    pending = request; setBusy(true); question.value = ''; autosize();
    try {
      async function post(url, body) {
        const response = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || '客服暂时不可用。');
        return payload;
      }
      let payload = await post(endpoint, { question: value, history: history.slice(0, -1).slice(-24) });
      if (payload.jobId && payload.receiptToken) {
        request.receipt = { jobId: payload.jobId, receiptToken: payload.receiptToken };
        while (payload.state === 'queued' || payload.state === 'processing') {
          await new Promise(resolve => setTimeout(resolve, 1500));
          controller.signal.throwIfAborted();
          payload = await post(`${endpoint}/result`, request.receipt);
        }
      }
      const answer = String(payload.answer || '').trim().replace(/#{2,3}/g, '\n\n');
      if (!answer) throw new Error('暂时没有生成回复。');
      if (id !== generation) return;
      typing.remove();
      const message = addMessage('assistant', answer);
      turn.original = answer;
      if (!turn.answerEdited) turn.answer = answer.slice(0, 2000);
      turn.state = '';
      if (visibleDraft === turn) renderTraining();
      const improve = document.createElement('button');
      improve.type = 'button'; improve.className = 'reply-training'; improve.textContent = '改进这条答复';
      improve.addEventListener('click', () => {
        trainingTurn.value = turn.key;
        renderTraining();
        training.scrollIntoView({ block: 'nearest' });
        trainingAnswer.focus();
      });
      message.lastElementChild.append(improve);
      history.push({ role: 'assistant', content: answer }); retryQuestion = '';
    } catch (error) {
      cancel(request);
      if (id !== generation) return;
      turn.state = '本轮未生成回复，可以填写训练答复。';
      if (visibleDraft === turn) renderTraining();
      typing.remove(); showFailure(controller.signal.aborted ? '响应时间较长，请稍后重试。' : error instanceof TypeError ? '暂时无法连接客服，请检查网络后重试。' : error.message);
    } finally {
      clearTimeout(timer);
      if (id === generation) {
        pending = null; setBusy(false);
        if (!training.contains(document.activeElement)) question.focus();
      }
    }
  }
  document.getElementById('training-test').addEventListener('click', () => {
    const value = trainingQuestion.value.trim();
    if (!value || pending) { trainingQuestion.focus(); return; }
    trainingTurn.value = 'latest';
    ask(value);
    question.scrollIntoView({ block: 'nearest' });
  });
  trainingForm.addEventListener('submit', async event => {
    event.preventDefault();
    const turn = visibleDraft;
    const draft = { question: trainingQuestion.value.trim(), answer: trainingAnswer.value.trim() };
    if (!turn || !draft.question || !draft.answer || turn.saving) return;
    turn.saving = true;
    turn.result = '正在保存…';
    renderTraining();
    try {
      const response = await fetch(`${api}/api/training/suggestions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft), signal: AbortSignal.timeout(15000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.state !== 'pending') throw new Error(payload.error || '提交失败，请稍后重试。');
      turn.result = '训练内容已保存，等待审核。';
    } catch (error) {
      turn.result = error instanceof TypeError || error.name === 'TimeoutError' ? '暂时无法连接，请稍后重试。' : error.message;
    } finally {
      turn.saving = false;
      if (visibleDraft === turn) renderTraining();
    }
  });
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
    turns.clear(); latestTurn = undefined; manualDraft = createDraft();
    while (trainingTurn.options.length > 2) trainingTurn.remove(2);
    trainingTurn.value = 'latest';
    renderTraining();
    messages.replaceChildren(welcome); welcome.hidden = false; status.textContent = ''; question.value = ''; autosize(); question.focus();
  });
  renderTraining();
})();
