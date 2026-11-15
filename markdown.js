/* DeepSeek Web · dependency-free Markdown renderer
   Everything is escaped before formatting; only whitelisted tags are produced. */
(function () {
  "use strict";

  var CODE_TOKEN = "\u0000CODE";
  var INLINE_TOKEN = "\u0000INLINE";
  var LINK_TOKEN = "\u0000LINK";

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, "&#96;");
  }

  function safeUrl(raw) {
    var url = String(raw || "").trim().replace(/&amp;/g, "&");
    if (!url) return null;
    if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
    if (/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(url)) return url;
    return null;
  }

  var KEYWORDS = {
    js: "const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of async await yield static get set delete void this null true false undefined",
    javascript: "const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of async await yield static get set delete void this null true false undefined",
    ts: "const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of async await yield static get set delete void this null true false undefined interface type enum implements readonly public private protected namespace declare abstract as satisfies keyof infer never unknown any string number boolean object",
    typescript: "const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of async await yield static get set delete void this null true false undefined interface type enum implements readonly public private protected namespace declare abstract as satisfies keyof infer never unknown any string number boolean object",
    jsx: "const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of async await yield static get set delete void this null true false undefined",
    tsx: "const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of async await yield static get set delete void this null true false undefined interface type enum implements readonly public private protected namespace declare abstract as satisfies keyof infer never unknown any string number boolean object",
    py: "def class return if elif else for while in not and or is import from as pass break continue try except finally raise with lambda yield global nonlocal assert del async await True False None self match case",
    python: "def class return if elif else for while in not and or is import from as pass break continue try except finally raise with lambda yield global nonlocal assert del async await True False None self match case",
    json: "true false null",
    css: "important media supports keyframes from to",
    sql: "select from where insert into update delete create table drop alter join left right inner outer on group by order having limit offset union all as distinct values set and or not null is like in between exists case when then else end primary key foreign references index default",
    bash: "if then else elif fi for while do done case esac function in export local echo cd ls cat grep sed awk curl git npm node python sudo rm mkdir touch chmod",
    sh: "if then else elif fi for while do done case esac function in export local echo cd ls cat grep sed awk curl git npm node python sudo rm mkdir touch chmod",
    yaml: "true false null yes no on off",
    yml: "true false null yes no on off",
  };

  var LANG_ALIASES = {
    js: "js", javascript: "js", mjs: "js", cjs: "js",
    ts: "ts", typescript: "ts", tsx: "tsx", jsx: "jsx",
    py: "py", python: "py", py3: "py",
    json: "json", jsonc: "json",
    html: "html", xml: "html", svg: "html", vue: "html",
    css: "css", scss: "css", less: "css",
    sql: "sql",
    sh: "bash", bash: "bash", shell: "bash", zsh: "bash", powershell: "bash", ps1: "bash",
    yaml: "yaml", yml: "yaml",
    diff: "diff", patch: "diff",
  };

  function normalizedLang(raw) {
    var l = String(raw || "").trim().toLowerCase().replace(/^language-/, "");
    return LANG_ALIASES[l] || l || "text";
  }

  function highlight(code, lang) {
    if (!code) return "";
    if (lang === "html") return highlightHtml(code);
    var isSql = lang === "sql";
    var hashComment = ["py", "bash", "yaml"].indexOf(lang) !== -1;
    var slashComment = ["js", "ts", "tsx", "jsx", "json", "css", "sql"].indexOf(lang) !== -1;
    var keywords = KEYWORDS[lang] || "";
    var kwSet = {};
    keywords.split(/\s+/).forEach(function (k) { if (k) kwSet[isSql ? k.toLowerCase() : k] = true; });
    var commentParts = [];
    if (slashComment) commentParts.push("\\/\\/[^\\n]*");
    if (hashComment) commentParts.push("#[^\\n]*");
    commentParts.push("\\/\\*[\\s\\S]*?\\*\\/");
    var re = new RegExp(
      "(" + commentParts.join("|") + ")" +
      "|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)" +
      "|\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b" +
      "|\\b([A-Za-z_$][\\w$]*)\\b",
      "g"
    );
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      out += escapeHtml(code.slice(last, m.index));
      if (m[1]) {
        out += '<span class="tok-com">' + escapeHtml(m[1]) + "</span>";
      } else if (m[2]) {
        out += '<span class="tok-str">' + escapeHtml(m[2]) + "</span>";
      } else if (m[3]) {
        out += '<span class="tok-num">' + escapeHtml(m[3]) + "</span>";
      } else {
        var word = m[4];
        var key = isSql ? word.toLowerCase() : word;
        var after = code.slice(m.index + word.length);
        if (kwSet[key]) out += '<span class="tok-key">' + escapeHtml(word) + "</span>";
        else if (/^\s*\(/.test(after)) out += '<span class="tok-fn">' + escapeHtml(word) + "</span>";
        else out += escapeHtml(word);
      }
      last = re.lastIndex;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function highlightHtml(code) {
    var re = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][^>]*?\/?>)/g;
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += '<span class="tok-com">' + escapeHtml(m[1]) + "</span>";
      else {
        var tag = m[2];
        var tagEsc = escapeHtml(tag);
        tagEsc = tagEsc.replace(/(&lt;\/?)([A-Za-z][\w:-]*)/, '$1<span class="tok-tag">$2</span>');
        tagEsc = tagEsc.replace(/([A-Za-z_:][\w:.-]*)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="tok-attr">$1</span>$2<span class="tok-str">$3</span>');
        out += tagEsc;
      }
      last = re.lastIndex;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  function renderCode(code, rawLang) {
    var lang = normalizedLang(rawLang);
    var label = lang === "text" ? "text" : lang;
    var body;
    if (lang === "diff") {
      body = code.split("\n").map(function (line) {
        var cls = "";
        if (/^\+/.test(line)) cls = " add";
        else if (/^-/.test(line)) cls = " del";
        else if (/^@@/.test(line)) cls = " hunk";
        return '<span class="diff-line' + cls + '">' + escapeHtml(line || " ") + "</span>";
      }).join("");
    } else {
      body = highlight(code.replace(/\n$/, ""), lang);
    }
    return '<div class="code-block" data-lang="' + escapeAttr(label) + '">' +
      '<div class="code-head"><span class="code-lang">' + escapeHtml(label) + "</span>" +
      '<button class="code-copy" type="button" data-copy-code aria-label="复制代码">' +
      '<svg><use href="#i-copy"></use></svg><span>复制</span></button></div>' +
      "<pre><code>" + body + "</code></pre></div>";
  }

  function inline(raw) {
    if (!raw) return "";
    var inlineCodes = [];
    var text = String(raw).replace(/`([^`\n]+)`/g, function (_, code) {
      var i = inlineCodes.push("<code>" + escapeHtml(code) + "</code>") - 1;
      return INLINE_TOKEN + i + "\u0000";
    });

    text = escapeHtml(text);

    // Protect explicit links/images before auto-linking.
    var links = [];
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, url) {
      var safe = safeUrl(url);
      if (!safe) return escapeHtml(alt);
      var html = '<img src="' + escapeAttr(safe) + '" alt="' + escapeAttr(alt) + '" loading="lazy" decoding="async">';
      var i = links.push(html) - 1;
      return LINK_TOKEN + i + "\u0000";
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
      var safe = safeUrl(url);
      if (!safe) return label;
      var html = '<a href="' + escapeAttr(safe) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
      var i = links.push(html) - 1;
      return LINK_TOKEN + i + "\u0000";
    });

    // Auto-link bare URLs not already in an anchor.
    text = text.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, function (_, pre, url) {
      var clean = url.replace(/[.,;:!?，。；：！？]+$/, "");
      var tail = url.slice(clean.length);
      var safe = safeUrl(clean);
      if (!safe) return pre + url;
      return pre + '<a href="' + escapeAttr(safe) + '" target="_blank" rel="noopener noreferrer">' + clean + "</a>" + tail;
    });

    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>")
      .replace(/\n/g, "<br>");

    // Restore protected anchors then inline code.
    text = text.replace(/\u0000LINK(\d+)\u0000/g, function (_, i) { return links[+i] || ""; });
    text = text.replace(/\u0000INLINE(\d+)\u0000/g, function (_, i) { return inlineCodes[+i] || ""; });
    return text;
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|").map(function (cell) { return cell.trim(); });
  }

  function alignmentOf(sep) {
    var left = sep.charAt(0) === ":";
    var right = sep.charAt(sep.length - 1) === ":";
    if (left && right) return "center";
    if (right) return "right";
    return "";
  }

  function renderTable(rows, aligns) {
    var head = rows[0].map(function (cell, i) {
      var align = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "";
      return "<th" + align + ">" + inline(cell) + "</th>";
    }).join("");
    var body = rows.slice(1).map(function (row) {
      var cells = [];
      for (var i = 0; i < rows[0].length; i++) {
        var align = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "";
        cells.push("<td" + align + ">" + inline(row[i] || "") + "</td>");
      }
      return "<tr>" + cells.join("") + "</tr>";
    }).join("");
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function renderList(items) {
    var root = { children: [], indent: -1, ordered: false };
    var stack = [root];
    items.forEach(function (item) {
      while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
      var node = {
        content: item.content,
        ordered: item.ordered,
        number: item.number,
        task: item.task,
        checked: item.checked,
        children: [],
        indent: item.indent,
      };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    });
    return renderChildren(root.children);
  }

  function renderChildren(children) {
    var out = "";
    var i = 0;
    while (i < children.length) {
      var ordered = children[i].ordered;
      var group = [];
      while (i < children.length && children[i].ordered === ordered) group.push(children[i++]);
      var hasTask = group.some(function (n) { return n.task; });
      var tag = ordered ? "ol" : "ul";
      var attrs = "";
      if (ordered && group[0].number && group[0].number !== 1) attrs = ' start="' + group[0].number + '"';
      if (hasTask) attrs += ' class="task-list"';
      var lis = group.map(function (node) {
        var content = node.content;
        var prefix = "";
        if (node.task) {
          prefix = '<span class="task-check' + (node.checked ? " checked" : "") + '">' + (node.checked ? "✓" : "") + "</span>";
        }
        var childrenHtml = node.children.length ? renderChildren(node.children) : "";
        return "<li>" + prefix + "<span>" + inline(content) + "</span>" + childrenHtml + "</li>";
      }).join("");
      out += "<" + tag + attrs + ">" + lis + "</" + tag + ">";
    }
    return out;
  }

  function renderBlocks(lines, codeBlocks) {
    var html = [];
    var i = 0;

    function pushParagraph(buf) {
      if (!buf.length) return;
      html.push("<p>" + inline(buf.join("\n").trim()) + "</p>");
      buf.length = 0;
    }

    var paragraph = [];

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      if (!trimmed) {
        pushParagraph(paragraph);
        i++;
        continue;
      }

      var codeMatch = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
      if (codeMatch) {
        pushParagraph(paragraph);
        html.push(codeBlocks[+codeMatch[1]] || "");
        i++;
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        pushParagraph(paragraph);
        var level = heading[1].length;
        html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        pushParagraph(paragraph);
        html.push("<hr>");
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        pushParagraph(paragraph);
        var quote = [];
        while (i < lines.length && (/^\s*>/.test(lines[i]) || !lines[i].trim())) {
          if (!lines[i].trim()) {
            if (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) {
              quote.push("");
              i++;
              continue;
            }
            break;
          }
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        html.push("<blockquote>" + renderBlocks(quote, codeBlocks) + "</blockquote>");
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        pushParagraph(paragraph);
        var header = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(alignmentOf);
        var rows = [header];
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        html.push(renderTable(rows, aligns));
        continue;
      }

      var listMatch = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (listMatch) {
        pushParagraph(paragraph);
        var items = [];
        while (i < lines.length) {
          var lm = lines[i].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
          if (lm) {
            var content = lm[3];
            var task = false;
            var checked = false;
            var taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
            if (taskMatch) {
              task = true;
              checked = taskMatch[1].toLowerCase() === "x";
              content = taskMatch[2];
            }
            items.push({
              indent: lm[1].replace(/\t/g, "    ").length,
              ordered: /^\d/.test(lm[2]),
              number: parseInt(lm[2], 10),
              content: content,
              task: task,
              checked: checked,
            });
            i++;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1].content += " " + lines[i].trim();
            i++;
          } else {
            break;
          }
        }
        html.push(renderList(items));
        continue;
      }

      paragraph.push(line);
      i++;
    }
    pushParagraph(paragraph);
    return html.join("");
  }

  function render(markdown) {
    var src = String(markdown == null ? "" : markdown).replace(/\r\n?/g, "\n");
    var lines = src.split("\n");
    var codeBlocks = [];
    var kept = [];
    var i = 0;

    while (i < lines.length) {
      var fence = lines[i].match(/^\s*```\s*([^\s`]*)\s*$/);
      if (fence) {
        var lang = fence[1] || "text";
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        var idx = codeBlocks.push(renderCode(code.join("\n"), lang)) - 1;
        kept.push(CODE_TOKEN + idx + "\u0000");
      } else {
        kept.push(lines[i]);
        i++;
      }
    }

    return renderBlocks(kept, codeBlocks);
  }

  function toText(markdown) {
    if (typeof document !== "undefined") {
      var host = document.createElement("div");
      host.innerHTML = render(markdown);
      return (host.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    }
    return String(markdown || "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[#>*_`~-]/g, "")
      .trim();
  }

  window.DSMarkdown = { render: render, toText: toText, escapeHtml: escapeHtml };
})();
