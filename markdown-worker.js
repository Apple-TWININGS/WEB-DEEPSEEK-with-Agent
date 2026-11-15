/* DeepSeek Web · Markdown rendering worker
   Keeps long streaming responses off the main thread. */
importScripts("markdown.js");

self.onmessage = function (event) {
  var data = event.data || {};
  var id = data.id;
  var text = typeof data.text === "string" ? data.text : "";
  try {
    var html = self.DSMarkdown.render(text);
    self.postMessage({ id: id, html: html });
  } catch (error) {
    self.postMessage({ id: id, error: String(error && error.message || error) });
  }
};
