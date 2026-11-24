/**
 * Единый инбокс. Клиент пишет в мессенджер — диалог появляется здесь,
 * сотрудник отвечает из CRM, ответ уходит в тот же канал.
 * Новые сообщения приходят через long-poll, без постоянных опросов.
 */
import {
  api, CHANNELS, clock, dayLabel, empty, h, initials, mount, toast, upload, when,
} from "../core.js";
import { openCreate as openTaskCreate } from "./tasks.js";

let poller = null;

export async function renderInbox(host) {
  clearTimeout(poller);

  const threads = h("div", { class: "threads" });
  const dialog = h("div", { class: "dialog" });
  mount(host, h("div", { class: "inbox" }, threads, dialog));

  const view = { channel: "", activeId: null, lastMessageId: 0 };

  const filter = h("select", {
    onchange: () => { view.channel = filter.value; loadThreads(); },
  },
    h("option", { value: "" }, "Все каналы"),
    ...Object.entries(CHANNELS).map(([k, v]) => h("option", { value: k }, v))
  );

  const demoBtn = h("button", {
    class: "btn quiet", title: "Имитировать входящее сообщение",
    onclick: async () => {
      try {
        await api("/webhooks/simulate", { method: "POST", body: {} });
        toast("Входящее сообщение получено");
        loadThreads();
      } catch (err) { toast(err.message); }
    },
  }, "+ Демо-обращение");

  async function loadThreads() {
    const list = await api(`/inbox/conversations${view.channel ? `?channel=${view.channel}` : ""}`);
    mount(threads,
      h("div", { class: "threads-head" },
        h("div", { class: "line", style: { marginBottom: "10px" } },
          h("b", { style: { fontSize: "15px", letterSpacing: "-0.01em" } }, "Диалоги"),
          h("div", { class: "spacer" }),
          demoBtn
        ),
        filter
      ),
      ...(list.length
        ? list.map((c) =>
            h("div", {
              class: "thread-row" + (c.id === view.activeId ? " on" : ""),
              onclick: () => openThread(c.id),
            },
              h("div", { class: "line" },
                h("div", { class: "avatar" }, initials(c.contact_name || c.subject || "К")),
                h("div", { style: { minWidth: 0, flex: 1 } },
                  h("div", { class: "line" },
                    h("span", { class: "name" }, c.contact_name || c.subject || `Чат ${c.external_chat_id}`),
                    h("span", { class: "when" }, when(c.last_message_at))
                  ),
                  h("div", { class: "preview" }, c.preview || "—")
                )
              ),
              h("div", { class: "line", style: { marginTop: "6px", paddingLeft: "34px" } },
                h("span", { class: "chip" }, CHANNELS[c.channel_type] || c.channel_type),
                c.status === "closed" ? h("span", { class: "chip plain" }, "закрыт") : null,
                h("div", { class: "spacer" }),
                c.unread_count ? h("span", { class: "unread" }, String(c.unread_count)) : null
              )
            )
          )
        : [empty("Обращений пока нет. Нажмите «Демо-обращение», чтобы увидеть, как это работает.")])
    );
  }

  async function openThread(id) {
    view.activeId = id;
    const conv = await api(`/inbox/conversations/${id}`);
    view.lastMessageId = Math.max(view.lastMessageId, ...conv.messages.map((m) => m.id), 0);

    const body = h("div", { class: "dialog-body" });
    const input = h("textarea", { placeholder: "Ответить клиенту в его мессенджер…", rows: 1 });
    const sendBtn = h("button", { class: "btn solid" }, "Отправить");
    const fileInput = h("input", { type: "file", style: { display: "none" } });
    const attachChip = h("span", { class: "chip plain", style: { display: "none" } });
    const replies = h("div", { class: "replies", style: { display: "none" } });
    let attachment = null;

    const paint = (messages) => {
      let lastDay = "";
      mount(body,
        ...messages.flatMap((m) => {
          const day = dayLabel(m.created_at);
          const nodes = [];
          if (day !== lastDay) { nodes.push(h("div", { class: "day" }, day)); lastDay = day; }
          nodes.push(
            h("div", { class: `msg ${m.direction}` },
              m.body,
              m.attachment_url ? h("div", {}, h("a", { href: m.attachment_url, target: "_blank", rel: "noreferrer" }, "вложение")) : null,
              h("div", { class: "stamp" },
                clock(m.created_at) + (m.direction === "outbound" && !m.delivered ? " · не доставлено" : ""))
            )
          );
          return nodes;
        })
      );
      body.scrollTop = body.scrollHeight;
    };

    const send = async () => {
      const text = input.value.trim();
      if (!text && !attachment) return;
      sendBtn.disabled = true;
      try {
        await api(`/inbox/conversations/${id}/reply`, {
          method: "POST",
          body: { body: text, attachment_id: attachment?.id ?? null },
        });
        input.value = "";
        input.style.height = "auto";
        attachment = null;
        attachChip.style.display = "none";
        const fresh = await api(`/inbox/conversations/${id}`);
        paint(fresh.messages);
        loadThreads();
      } catch (err) { toast(err.message); } finally { sendBtn.disabled = false; }
    };

    /* Шаблоны быстрых ответов: кнопка, «/» в пустом поле и Ctrl+Пробел. */
    const toggleReplies = async () => {
      if (replies.style.display === "block") { replies.style.display = "none"; return; }
      const list = await api("/quick-replies");
      mount(replies,
        ...(list.length
          ? list.map((item) =>
              h("div", {
                class: "reply-hit",
                onclick: () => {
                  input.value = input.value.replace(/\/[^\s]*$/, "") + item.body;
                  replies.style.display = "none";
                  input.focus();
                  api(`/quick-replies/${item.id}`, { method: "PATCH", body: { used: true } }).catch(() => {});
                },
              },
                h("b", {}, item.title),
                item.shortcut ? h("span", { class: "mono" }, `/${item.shortcut}`) : null,
                h("span", { class: "reply-body" }, item.body)
              )
            )
          : [h("div", { class: "empty" }, "Шаблоны создаются в настройках")])
      );
      replies.style.display = "block";
    };

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        attachment = await upload("/files", file, { "X-Entity": "conversation", "X-Entity-Id": String(id) });
        attachChip.textContent = `📎 ${attachment.filename}`;
        attachChip.style.display = "inline-flex";
        toast("Файл загружен, уйдёт вместе с сообщением");
      } catch (err) { toast(err.message); }
      fileInput.value = "";
    });

    sendBtn.onclick = send;
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
      if (e.key === " " && e.ctrlKey) { e.preventDefault(); toggleReplies(); }
      if (e.key === "/" && !input.value) { e.preventDefault(); toggleReplies(); }
      if (e.key === "Escape") replies.style.display = "none";
    });

    mount(dialog,
      h("div", { class: "dialog-head" },
        h("div", { class: "avatar" }, initials(conv.contact?.full_name || conv.subject || "К")),
        h("div", {},
          h("div", { style: { fontWeight: 500 } }, conv.contact?.full_name || conv.subject || conv.external_chat_id),
          h("div", { style: { fontSize: "12px", color: "var(--ink-4)" } },
            `${CHANNELS[conv.channel_type] || conv.channel_type} · ${conv.contact?.phone || conv.external_chat_id}`)
        ),
        h("div", { class: "spacer", style: { flex: 1 } }),
        h("button", {
          class: "btn quiet",
          onclick: () => openTaskCreate(
            { conversation_id: id, contact_id: conv.contact_id, kind: "call" },
            () => toast("Задача поставлена")
          ),
        }, "+ Задача"),
        h("button", {
          class: "btn quiet",
          onclick: async () => {
            await api(`/inbox/conversations/${id}`, { method: "PATCH", body: { status: conv.status === "closed" ? "open" : "closed" } });
            toast(conv.status === "closed" ? "Диалог открыт" : "Диалог закрыт");
            loadThreads(); openThread(id);
          },
        }, conv.status === "closed" ? "Открыть заново" : "Закрыть диалог")
      ),
      body,
      h("div", { class: "composer" },
        replies,
        h("div", { class: "box" },
          input,
          h("button", { class: "btn quiet", title: "Шаблоны быстрых ответов", onclick: toggleReplies }, "⌁"),
          h("button", { class: "btn quiet", title: "Прикрепить файл", onclick: () => fileInput.click() }, "📎"),
          sendBtn
        ),
        fileInput,
        h("div", { class: "hint" },
          attachChip,
          "⌘ + Enter — отправить, / — шаблоны. Сообщение уйдёт клиенту в " + (CHANNELS[conv.channel_type] || conv.channel_type))
      )
    );

    paint(conv.messages);
    input.focus();
  }

  mount(dialog, h("div", { class: "empty" }, "Выберите диалог слева"));
  await loadThreads();

  /* Long-poll: сервер держит запрос до появления нового сообщения. */
  const listen = async () => {
    try {
      const res = await api(`/inbox/updates?since=${view.lastMessageId}`);
      view.lastMessageId = res.last_message_id;
      if (res.changed) {
        await loadThreads();
        if (view.activeId) await openThread(view.activeId);
      }
    } catch { /* соединение прервано — просто повторим */ }
    if (document.querySelector(".inbox")) poller = setTimeout(listen, 400);
  };
  listen();
}
