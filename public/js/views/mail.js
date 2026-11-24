/** Почтовый ящик info@vapelab.bond внутри CRM. */
import { api, empty, h, mount, overlay, toast, when } from "../core.js";

const STATUS_LABELS = {
  a: "A-запись", mx: "MX", ptr: "PTR", spf: "SPF", dkim: "DKIM", dmarc: "DMARC",
};
const statusMark = (ok) => h("span", { class: `mail-status-mark ${ok ? "ok" : "bad"}` }, ok ? "Готово" : "Проверить");

export async function renderMail(host) {
  const statusHost = h("div", { class: "mail-health" }, h("div", { class: "muted" }, "Проверяем почтовый сервер…"));
  const folderHost = h("div", { class: "mail-folders" });
  const listHost = h("div", { class: "mail-list" });
  const detailHost = h("section", { class: "mail-detail" }, empty("Выберите письмо слева"));
  const state = { folder: "INBOX", folders: [], status: null, rows: [], activeUid: null };

  const refreshStatus = async () => {
    try {
      state.status = await api("/mail/status");
      const dns = state.status.dns || {};
      mount(statusHost,
        h("div", { class: "mail-health-head" },
          h("div", {},
            h("b", {}, state.status.address),
            h("span", { class: "muted" }, ` · ${state.status.host}`)
          ),
          h("span", { class: "mail-status-summary" }, state.status.configured ? "Конфигурация заполнена" : "Не настроено")
        ),
        h("div", { class: "mail-health-grid" },
          ...Object.entries(STATUS_LABELS).map(([key, label]) => h("div", { class: "mail-health-item" }, h("span", {}, label), statusMark(Boolean(dns[key]?.ok)))),
          h("div", { class: "mail-health-item" }, h("span", {}, "SMTP TLS · 465"), statusMark(Boolean(state.status.smtp?.ok))),
          h("div", { class: "mail-health-item" }, h("span", {}, "IMAP · 993"), statusMark(Boolean(state.status.imap?.ok && state.status.imap?.tcp?.ok)))
        ),
        h("p", { class: "muted mail-health-note" }, state.status.note || "")
      );
    } catch (error) {
      mount(statusHost, h("div", { class: "mail-error" }, error.message));
    }
  };

  async function loadFolders() {
    state.folders = await api("/mail/folders");
    if (!state.folders.some((folder) => folder.path === state.folder)) state.folder = state.folders.find((folder) => folder.specialUse === "\\Inbox")?.path || "INBOX";
    mount(folderHost,
      ...state.folders.map((folder) => h("button", {
        class: `mail-folder ${state.folder === folder.path ? "active" : ""}`,
        onclick: () => { state.folder = folder.path; state.activeUid = null; loadMessages(); },
      }, folder.name || folder.path))
    );
  }

  async function loadMessages() {
    try {
      const rows = await api(`/mail/messages?folder=${encodeURIComponent(state.folder)}&limit=50`);
      state.rows = rows;
      mount(listHost,
        h("div", { class: "mail-list-head" },
          h("b", {}, state.folder === "INBOX" ? "Входящие" : (state.folders.find((f) => f.path === state.folder)?.name || state.folder)),
          h("span", { class: "muted" }, String(rows.length)),
          h("div", { class: "spacer" }),
          h("button", { class: "btn quiet", onclick: loadMessages, title: "Обновить список" }, "↻")
        ),
        ...(rows.length ? rows.map((row) => h("button", {
          class: `mail-row ${row.uid === state.activeUid ? "active" : ""} ${row.seen ? "seen" : "unseen"}`,
          onclick: () => openMessage(row.uid),
        },
          h("div", { class: "mail-row-top" },
            h("b", {}, row.from || "Неизвестный отправитель"),
            h("time", {}, when(row.date))
          ),
          h("div", { class: "mail-row-subject" }, row.subject || "(без темы)"),
          h("div", { class: "mail-row-meta" }, row.to ? `Кому: ${row.to}` : "")
        )) : [empty("В этой папке пока нет писем")])
      );
    } catch (error) { mount(listHost, h("div", { class: "mail-error" }, error.message)); }
  }

  async function openMessage(uid) {
    state.activeUid = uid;
    const row = state.rows.find((item) => item.uid === uid);
    mount(detailHost, h("div", { class: "muted" }, "Открываем письмо…"));
    try {
      const message = await api(`/mail/messages/${uid}?folder=${encodeURIComponent(state.folder)}`);
      mount(detailHost,
        h("div", { class: "mail-detail-head" },
          h("h2", {}, message.subject || "(без темы)"),
          h("div", { class: "mail-message-meta" },
            h("div", {}, h("b", {}, "От: "), message.from),
            h("div", {}, h("b", {}, "Кому: "), message.to),
            h("div", {}, h("b", {}, "Дата: "), new Date(message.date).toLocaleString("ru-RU"))
          ),
          h("div", { class: "mail-actions" },
            h("button", { class: "btn quiet", onclick: () => compose({ to: message.from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "", subject: `Re: ${message.subject}` }) }, "Ответить")
          )
        ),
        h("pre", { class: "mail-message-body" }, message.text || "(письмо не содержит текстовой части)"),
      );
      if (row) row.seen = true;
      await loadMessages();
    } catch (error) { mount(detailHost, h("div", { class: "mail-error" }, error.message)); }
  }

  function compose(seed = {}) {
    const to = h("input", { type: "email", required: true, value: seed.to || "", placeholder: "Получатель" });
    const subject = h("input", { required: true, value: seed.subject || "", placeholder: "Тема письма" });
    const text = h("textarea", { rows: 10, required: true, placeholder: "Текст сообщения" });
    const send = h("button", { class: "btn solid" }, "Отправить");
    const close = overlay(h("div", { class: "mail-compose" },
      h("div", { class: "mail-compose-head" }, h("h2", {}, "Новое письмо"), h("button", { class: "btn quiet", onclick: () => close() }, "Закрыть")),
      h("label", {}, "Кому", to),
      h("label", {}, "Тема", subject),
      h("label", {}, "Сообщение", text),
      h("div", { class: "mail-compose-actions" }, send)
    ));
    send.onclick = async () => {
      send.disabled = true;
      try {
        const result = await api("/mail/send", { method: "POST", body: { to: to.value, subject: subject.value, text: text.value } });
        close();
        toast(result.savedInSent ? "Письмо отправлено и сохранено" : "Письмо принято SMTP; копия в «Отправленных» не сохранена");
        if (/sent/i.test(state.folder)) await loadMessages();
      } catch (error) { toast(error.message); }
      finally { send.disabled = false; }
    };
    to.focus();
  }

  const toolbar = h("div", { class: "mail-page-head" },
    h("div", {}, h("h1", {}, "Почта"), h("p", { class: "muted" }, "Единый почтовый ящик VAPELAB")),
    h("div", { class: "mail-page-actions" },
      h("button", { class: "btn quiet", onclick: async () => { await refreshStatus(); toast("Проверка обновлена"); } }, "Проверить сервер"),
      h("button", { class: "btn quiet", onclick: async () => {
        try { const result = await api("/mail/test", { method: "POST", body: {} }); toast(`Тестовое письмо принято SMTP: ${result.to}`); }
        catch (error) { toast(error.message); }
      } }, "Тест отправки"),
      h("button", { class: "btn solid", onclick: () => compose() }, "+ Написать")
    )
  );

  mount(host,
    h("div", { class: "mail-page" },
      toolbar,
      statusHost,
      h("div", { class: "mail-workspace" },
        h("aside", { class: "mail-sidebar" }, folderHost),
        listHost,
        detailHost
      )
    )
  );
  await refreshStatus();
  try { await loadFolders(); await loadMessages(); }
  catch (error) { mount(listHost, h("div", { class: "mail-error" }, error.message)); }
}
