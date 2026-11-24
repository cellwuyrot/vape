import { api, h, toast } from "../core.js";

const ROLE_LABELS = { admin:"Администратор", manager:"Менеджер", agent:"Сотрудник", viewer:"Наблюдатель" };
const ROLE_OPTIONS = ["manager", "agent", "viewer"];

export async function renderUsers(root) {
  const payload = await api("/users");
  const users = payload.data || payload;
  const head = h("div", { class:"section-head" }, h("div",{},
    h("h2",{},"Команда VAPELAB"),
    h("p",{class:"muted"},"Менеджеры имеют одинаковые рабочие права. Каждый менеджер управляет аккаунтами, назначенными им или его командой; вышестоящие менеджеры защищены от удаления подчинёнными.")
  ));
  const name = h("input", { placeholder:"Имя сотрудника" });
  const email = h("input", { type:"email", placeholder:"manager@vaplab.ru", required:true });
  const role = h("select", {}, h("option",{value:"manager"},"Менеджер"), h("option",{value:"agent"},"Сотрудник"), h("option",{value:"viewer"},"Наблюдатель"));
  const status = h("div", { class:"muted" });
  const form = h("form", { class:"panel team-create", onsubmit:async (event)=>{
    event.preventDefault();
    const button=form.querySelector("button[type=submit]"); button.disabled=true;
    try {
      const created=await api("/users",{method:"POST",body:{full_name:name.value,email:email.value,role:role.value}});
      status.textContent=created.email_sent ? "Приглашение отправлено на почту." : "Профиль создан. Проверьте настройки почтового сервера.";
      toast("Профиль сотрудника создан"); name.value=""; email.value=""; await renderUsers(root);
    } catch(error){status.textContent=error.message;}
    finally{button.disabled=false;}
  } }, h("h3",{},"Добавить сотрудника или менеджера"), h("div",{class:"team-fields"},name,email,role), h("button",{class:"btn solid",type:"submit"},"Создать и отправить приглашение"),status);

  const rows = users.map((user)=>{
    const actions = user.can_manage ? (() => {
      const selectRole = h("select", { "aria-label":`Роль сотрудника ${user.full_name || user.email}` },
        ...ROLE_OPTIONS.map((value)=>h("option",{value,selected:user.role===value},ROLE_LABELS[value]))
      );
      return h("div",{class:"team-actions"},
        h("button",{class:"btn quiet",onclick:async()=>{
          try { await api(`/users/${user.id}`,{method:"PUT",body:{role:selectRole.value}}); toast("Роль обновлена"); await renderUsers(root); }
          catch(error){toast(error.message);}
        }},"Сохранить роль"),
        h("button",{class:"btn quiet",onclick:async()=>{
          try { await api(`/users/${user.id}`,{method:"PUT",body:{is_active:!user.is_active}}); await renderUsers(root); }
          catch(error){toast(error.message);}
        }},user.is_active ? "Отключить" : "Включить"),
        h("button",{class:"btn danger",onclick:async()=>{
          const title=user.full_name || user.email || "сотрудника";
          if(!confirm(`Удалить ${title} из команды? Аккаунт будет отключён и скрыт из списка. История CRM сохранится. Его прямые подчинённые перейдут под ваше управление.`)) return;
          try { await api(`/users/${user.id}`,{method:"DELETE"}); toast("Аккаунт удалён из команды"); await renderUsers(root); }
          catch(error){toast(error.message);}
        }},"Удалить")
      );
    })() : h("span",{class:"muted"},"Нет прав управления");
    return h("tr",{},
      h("td",{},h("strong",{},user.full_name || "Без имени"),h("small",{},user.email)),
      h("td",{},ROLE_LABELS[user.role] || user.role),
      h("td",{},user.is_active ? (user.email_verified ? "Активен" : "Ожидает первого входа") : "Отключён"),
      h("td",{},user.last_login_at ? new Date(user.last_login_at).toLocaleString("ru-RU") : "Ещё не входил"),
      h("td",{},actions)
    );
  });
  const table=h("div",{class:"table-wrap"},h("table",{class:"table"},
    h("thead",{},h("tr",{},... ["Сотрудник","Роль","Статус","Последний вход","Действия"].map((x)=>h("th",{},x)))),
    h("tbody",{},...rows)
  ));
  root.replaceChildren(head,form,h("div",{class:"panel"},h("h3",{},"Список аккаунтов команды"),table));
}
