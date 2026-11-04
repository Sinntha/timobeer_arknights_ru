// ==UserScript==
// @name         Arknights RU — подстановка переводов (Timo's Story Reader)
// @namespace    arknights-ru
// @version      1.3.0
// @description  Подставляет облачные переводы историй и русские названия глав в читалку arknights.timo.beer
// @match        https://arknights.timo.beer/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_info
// @connect      *
// ==/UserScript==


(function () {
  "use strict";


  const CLOUD_BASE = "https://sinntha.github.io/timobeer__translation_ru";


  function installedBase() {
    try {
      const info = typeof GM_info !== "undefined" ? GM_info : null;
      const script = info && info.script;
      const url = script && (script.downloadURL || script.updateURL || "");
      if (!url) return "";
      const match =
        /^(https?:\/\/[^?#]+?)\/userscript\/arknights-ru\.user\.js(?:[?#].*)?$/i.exec(
          url,
        );
      return match ? normalizeBase(match[1]) : "";
    } catch (err) {
      return "";
    }
  }


  const DEFAULT_TRANSLATION_BASES = [installedBase() || CLOUD_BASE, CLOUD_BASE];

  const TRANSLATIONS_STORAGE_KEY = "arkru_translations_base";


  const EMBEDDED = {

  };

  // ------------------------------------------------------------- окружение

  const pageWindow =
    typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  const PageResponse = pageWindow.Response || Response;
  const PageHeaders = pageWindow.Headers || Headers;
  const origFetch = pageWindow.fetch.bind(pageWindow);

  const STORY_RE =
    /\/game\/(?:en|cn|jp|kr|tw)\/gamedata\/story\/([^?#]+)\.txt(?:[?#]|$)/i;
  const CATALOG_RE =
    /\/json\/catalog\.(?:en|cn|jp|kr|tw)\.json(?:[?#]|$)/i;

  const cache = new Map(); // ключ -> текст перевода (негатив не кэшируем)
  let titlesPromise = null;

  // ------------------------------------------------------------- адреса

  function normalizeBase(value) {
    let text = String(value == null ? "" : value).trim();
    if (!text) return "";
    if (!/^https?:\/\//i.test(text)) text = "https://" + text;
    text = text.replace(/\/+$/, "");
    text = text.replace(/\/translations$/i, "");
    return text;
  }

  function customTranslationsBase() {
    try {
      return normalizeBase(GM_getValue(TRANSLATIONS_STORAGE_KEY, ""));
    } catch (err) {
      return "";
    }
  }

  function translationBases() {
    const result = [];
    const custom = customTranslationsBase();
    if (custom) result.push(custom);
    for (const candidate of DEFAULT_TRANSLATION_BASES) {
      const base = normalizeBase(candidate);
      if (base && result.indexOf(base) === -1) result.push(base);
    }
    return result;
  }

  function translationSources() {
    return translationBases().map(function (base) {
      return base + "/translations/";
    });
  }

  // ------------------------------------------------------------- запросы

  function gmGet(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest недоступен"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        timeout: 8000,
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        onload: function (res) {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error("HTTP " + res.status));
        },
        onerror: function () {
          reject(new Error("network error"));
        },
        ontimeout: function () {
          reject(new Error("timeout"));
        },
        onabort: function () {
          reject(new Error("aborted"));
        },
      });
    });
  }

  async function requestText(url) {
    if (typeof GM_xmlhttpRequest === "function") return gmGet(url);
    const res = await origFetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  }

  function keyOf(url) {
    const m = STORY_RE.exec(String(url));
    return m ? m[1] : null;
  }

  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.href === "string") return input.href;
      if (input && typeof input.url === "string") return input.url;
    } catch (err) {
      // ignore
    }
    return "";
  }

  // ------------------------------------------------------------- переводы

  async function loadTitles() {
    if (titlesPromise) return titlesPromise;
    titlesPromise = (async function () {
      for (const source of translationSources()) {
        try {
          const text = await requestText(source + "catalog_titles.json");
          return JSON.parse(text);
        } catch (err) {
          // источник недоступен — пробуем следующий
        }
      }
      return null;
    })();
    return titlesPromise;
  }

  function patchCatalog(catalog, titles) {
    if (!catalog || !titles) return catalog;
    const groups = titles.groups || {};
    const stories = titles.stories || {};
    for (const gid of Object.keys(groups)) {
      const group = catalog.review && catalog.review[gid];
      if (group && typeof group === "object") group.name = groups[gid];
    }
    const review = catalog.review || {};
    for (const gid of Object.keys(review)) {
      const group = review[gid];
      if (!group || !Array.isArray(group.infoUnlockDatas)) continue;
      for (const row of group.infoUnlockDatas) {
        if (row && stories[row.storyTxt]) row.storyName = stories[row.storyTxt];
      }
    }
    return catalog;
  }

  async function findTranslation(key) {
    if (Object.prototype.hasOwnProperty.call(EMBEDDED, key)) return EMBEDDED[key];
    if (cache.has(key)) return cache.get(key);
    for (const source of translationSources()) {
      try {
        const text = await requestText(source + key + ".txt");
        cache.set(key, text);
        return text;
      } catch (err) {
        // источник недоступен — пробуем следующий
      }
    }
    return null;
  }

  // ------------------------------------------------------------- меню

  function setupMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("Настроить адрес переводов", function () {
      const current = customTranslationsBase() || CLOUD_BASE;
      const value = pageWindow.prompt(
        "Базовый адрес переводов (например, https://USERNAME.github.io/arknights-ru):",
        current,
      );
      if (value === null) return;
      const normalized = normalizeBase(value);
      if (!normalized) {
        pageWindow.alert("Пустой или некорректный адрес.");
        return;
      }
      try {
        GM_setValue(TRANSLATIONS_STORAGE_KEY, normalized);
      } catch (err) {
        pageWindow.alert("Не удалось сохранить адрес: " + err);
        return;
      }
      pageWindow.alert("Сохранено: " + normalized + "\nПерезагрузите страницу.");
    });

    GM_registerMenuCommand("Проверить связь с переводами", async function () {
      const bases = translationBases();
      for (const base of bases) {
        try {
          await requestText(base + "/translations/catalog_titles.json");
          pageWindow.alert("Связь есть: " + base);
          return;
        } catch (err) {
          // пробуем следующий адрес
        }
      }
      pageWindow.alert(
        "Не удалось связаться ни с одним адресом:\n" +
          bases.join("\n") +
          "\n\nПроверьте, что GitHub Pages опубликован, файлы лежат в " +
          "translations/, а адрес указан без /translations на конце.",
      );
    });

    GM_registerMenuCommand("Сбросить адрес переводов", function () {
      try {
        GM_setValue(TRANSLATIONS_STORAGE_KEY, "");
      } catch (err) {
        // ignore
      }
      pageWindow.alert("Адрес сброшен. Перезагрузите страницу.");
    });
  }

  // ------------------------------------------------------------- подмена

  pageWindow.fetch = function (input, init) {
    const url = urlOf(input);

    if (CATALOG_RE.test(url)) {
      return origFetch(input, init).then(async function (res) {
        if (!res.ok) return res;
        const titles = await loadTitles();
        if (!titles) return res;
        try {
          const catalog = await res.clone().json();
          patchCatalog(catalog, titles);
          const headers = new PageHeaders(res.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          headers.set("content-type", "application/json; charset=utf-8");
          return new PageResponse(JSON.stringify(catalog), {
            status: res.status,
            statusText: res.statusText,
            headers: headers,
          });
        } catch (err) {
          return res;
        }
      });
    }

    const key = keyOf(url);
    if (!key) return origFetch(input, init);

    return findTranslation(key).then(function (text) {
      if (text == null) return origFetch(input, init);
      return new PageResponse(text, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    });
  };

  setupMenu();
  console.info(
    "[arknights-ru] v1.3.0 active; translations: " +
      translationBases().join(", "),
  );
})();
