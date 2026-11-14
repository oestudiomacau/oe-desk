(() => {
  const trainingButton = document.getElementById('training-button');
  if (!trainingButton) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = trainingButton.className;
  button.textContent = '网页训练建议';
  trainingButton.after(button);

  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'public-review-title');
  dialog.style.cssText = 'width:min(640px,calc(100% - 30px));max-height:80vh;border:1px solid #dfe7e1;border-radius:16px;padding:22px;color:inherit;';
  dialog.innerHTML = `
    <div class="inline-actions" style="justify-content:space-between">
      <h2 id="public-review-title">网页训练建议</h2>
      <button class="quiet-button" type="button" data-close>关闭</button>
    </div>
    <p>核对事实和话术后再采纳。你可以先修改答复。</p>
    <button class="quiet-button" type="button" data-refresh>刷新建议</button>
    <p role="status" style="margin:10px 0"></p>
    <div data-suggestions></div>`;
  document.body.append(dialog);
  const list = dialog.querySelector('[data-suggestions]');
  const status = dialog.querySelector('[role=status]');
  const refresh = dialog.querySelector('[data-refresh]');
  let busy = false;

  async function request(body) {
    const response = await fetch('/api/public-chat/training', {
      method: body ? 'POST' : 'GET',
      headers: { 'x-oe-desk': 'review', ...(body && { 'content-type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '操作失败，请重试。');
    return payload;
  }

  function newAction(label, className) {
    const action = document.createElement('button');
    action.className = className;
    action.type = 'button';
    action.textContent = label;
    return action;
  }

  function render(suggestions) {
    list.replaceChildren();
    if (!suggestions.length) {
      list.textContent = '暂无待审核建议。';
      return;
    }
    for (const suggestion of suggestions) {
      const row = document.createElement('article');
      row.className = 'workspace-card';
      row.style.marginBottom = '10px';
      const question = document.createElement('h3');
      question.style.overflowWrap = 'anywhere';
      question.textContent = suggestion.question;
      const answer = document.createElement('textarea');
      answer.className = 'knowledge-textarea';
      answer.setAttribute('aria-label', '建议答复');
      answer.rows = 4;
      answer.maxLength = 2000;
      answer.value = suggestion.answer;
      const approve = newAction('采纳并更新知识库', 'primary');
      const dismiss = newAction('丢弃', 'quiet-button');
      const actions = document.createElement('div');
      actions.className = 'inline-actions';
      actions.append(approve, dismiss);
      row.append(question, answer, actions);
      list.append(row);
      approve.addEventListener('click', () => review('approve'));
      dismiss.addEventListener('click', () => review('dismiss'));

      async function review(action) {
        if (busy) return;
        if (action === 'approve' && !answer.value.trim()) { answer.focus(); return; }
        busy = refresh.disabled = approve.disabled = dismiss.disabled = true;
        status.textContent = '正在处理…';
        try {
          const result = await request({ id: suggestion.id, action, answer: answer.value });
          row.remove();
          if (!list.childElementCount) list.textContent = '本页建议已处理完，刷新可查看其余建议。';
          status.textContent = result.state === 'approved' ? '已采纳并更新知识库。' : '建议已丢弃。';
        } catch (error) {
          status.textContent = error.message;
        } finally {
          busy = refresh.disabled = approve.disabled = dismiss.disabled = false;
        }
      }
    }
  }

  async function load() {
    if (busy) return;
    busy = refresh.disabled = true;
    status.textContent = '正在读取网页建议…';
    try {
      const { suggestions } = await request();
      render(suggestions);
      status.textContent = '';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = refresh.disabled = false;
    }
  }

  button.addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.remove('open');
    button.dispatchEvent(new Event('public-chat-review-open', { bubbles: true }));
    dialog.showModal();
    load();
  });
  dialog.addEventListener('close', () => button.dispatchEvent(new Event('public-chat-review-close', { bubbles: true })));
  refresh.addEventListener('click', load);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
})();
