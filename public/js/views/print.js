/**
 * Печатные формы на стороне интерфейса.
 *
 * Сервер отдаёт готовый HTML документа, мы открываем его в отдельном окне
 * и вызываем печать. Браузер сам предлагает «Сохранить в PDF» — кириллица
 * остаётся кириллицей, а проект остаётся без единой внешней зависимости.
 */
import { DOC_KINDS, api, h, sheet, toast } from "../core.js";

export async function printDocument(code, target) {
  try {
    const document_ = await api("/documents/render", { method: "POST", body: { code, ...target } });
    const win = window.open("", "_blank");
    if (!win) return toast("Разрешите всплывающие окна, чтобы открыть печатную форму");
    win.document.write(document_.html);
    win.document.close();
    win.focus();
  } catch (err) {
    toast(err.message);
  }
}

/** Выбор бланка для заказа: КП, счёт, договор, акт. */
export function openPrintMenu(target) {
  const close = sheet("Печатная форма",
    h("div", { class: "stack" },
      ...Object.entries(DOC_KINDS).map(([code, label]) =>
        h("button", {
          class: "btn wide",
          onclick: () => { close(); printDocument(code, target); },
        }, label)
      ),
      h("p", { style: { fontSize: "12.5px", color: "var(--ink-4)" } },
        "Документ откроется в новой вкладке. Дальше — «Печать» и «Сохранить в PDF».")
    )
  );
}
