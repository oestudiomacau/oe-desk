/* State helpers for prompt and skill CRUD. Rendering remains owned by the workspace. */
(function () {
  function createSkill(name = '未命名技能') {
    return { id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, description: '', enabled: true };
  }

  function move(list, id, direction) {
    const index = list.findIndex(item => item.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= list.length) return list;
    const copy = [...list];
    [copy[index], copy[next]] = [copy[next], copy[index]];
    return copy;
  }

  function selected(list, id) {
    return list.find(item => item.id === id) || null;
  }

  window.RcbPromptSkillManager = { createSkill, move, selected };
}());
