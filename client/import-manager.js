/* Browser-side adapter for the local RAG ingestion endpoint. */
(function () {
  const supportedExtensions = ['.txt', '.md', '.csv', '.xlsx', '.xls', '.json'];

  function extension(name) {
    const index = name.lastIndexOf('.');
    return index < 0 ? '' : name.slice(index).toLowerCase();
  }

  function validate(files) {
    const invalid = [...files].find(file => !supportedExtensions.includes(extension(file.name)));
    if (invalid) throw new Error(`不支持 ${invalid.name}。支持 TXT、MD、CSV、Excel 和 JSON。`);
    if ([...files].some(file => file.size > 8 * 1024 * 1024)) throw new Error('单个文件不能超过 8 MB。');
  }

  function asBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }

  async function upload(scope, files) {
    validate(files);
    const payload = await Promise.all([...files].map(async file => ({ name: file.name, data: await asBase64(file) })));
    const response = await fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, files: payload })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '资料导入失败。');
    return result;
  }

  window.RcbImportManager = { supportedExtensions, upload };
}());
