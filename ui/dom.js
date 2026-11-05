export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text, action, className = 'text-action') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function field(label, input) {
  const wrapper = element('label', 'field-label', label);
  wrapper.append(input);
  return wrapper;
}

export function input(type, value = '') {
  const node = element('input', 'form-field');
  node.type = type;
  node.value = value;
  return node;
}

export function sectionSelect(sections, value = null) {
  const select = element('select', 'form-field');
  const option = element('option', '', 'Без раздела');
  option.value = '';
  select.append(option);
  for (const section of [...sections].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const option = element('option', '', section.name);
    option.value = section.id;
    select.append(option);
  }
  select.value = value ?? '';
  return select;
}
