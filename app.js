import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const state = {
  supabase: null,
  session: null,
  me: null,
  profiles: new Map(),
  conversations: [],
  activeConversation: null,
  activeOther: null,
  messages: [],
  realtimeChannel: null,
  editingMessageId: null,
  authMode: "login",
};

function escapeHtml(value = "") {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

function showToast(message, type = "info") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3600);
}

function setScreen(name) {
  ["setupScreen", "authScreen", "appScreen"].forEach((id) => $(id).classList.add("hidden"));
  $(name).classList.remove("hidden");
}

function getConnection() {
  return {
    url: localStorage.getItem("egoria_supabase_url") || DEFAULT_SUPABASE_URL,
    key: localStorage.getItem("egoria_supabase_key") || DEFAULT_SUPABASE_KEY,
  };
}

function initSupabase(url, key) {
  state.supabase = createClient(url.trim(), key.trim(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

async function boot() {
  applySavedTheme();
  const { url, key } = getConnection();
  if (!url || !key) {
    setScreen("setupScreen");
    return;
  }
  try {
    initSupabase(url, key);
    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    state.session = data.session;
    if (state.session) await enterApp();
    else setScreen("authScreen");

    state.supabase.auth.onAuthStateChange(async (_event, session) => {
      state.session = session;
      if (session && !state.me) await enterApp();
      if (!session) {
        cleanupRealtime();
        state.me = null;
        setScreen("authScreen");
      }
    });
  } catch (error) {
    console.error(error);
    localStorage.removeItem("egoria_supabase_url");
    localStorage.removeItem("egoria_supabase_key");
    setScreen("setupScreen");
    showToast("Не удалось подключиться к Supabase.", "error");
  }
}

$("setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("setupUrl").value.trim();
  const key = $("setupKey").value.trim();
  try {
    const testClient = createClient(url, key);
    const { error } = await testClient.auth.getSession();
    if (error) throw error;
    localStorage.setItem("egoria_supabase_url", url);
    localStorage.setItem("egoria_supabase_key", key);
    location.reload();
  } catch (error) {
    showToast("Неверный URL или публичный ключ.", "error");
  }
});

$("changeSetup").addEventListener("click", () => {
  localStorage.removeItem("egoria_supabase_url");
  localStorage.removeItem("egoria_supabase_key");
  location.reload();
});

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === "register";
  $("registerFields").classList.toggle("hidden", !registering);
  $("loginTab").classList.toggle("active", !registering);
  $("registerTab").classList.toggle("active", registering);
  $("authSubmit").textContent = registering ? "Создать аккаунт" : "Войти";
  $("authSubtitle").textContent = registering ? "Создай уникальный аккаунт" : "Войди в свой аккаунт";
  $("displayName").required = registering;
  $("username").required = registering;
  $("password").autocomplete = registering ? "new-password" : "current-password";
}
$("loginTab").onclick = () => setAuthMode("login");
$("registerTab").onclick = () => setAuthMode("register");

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  try {
    if (state.authMode === "login") {
      const { error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const username = $("username").value.trim().replace(/^@/, "").toLowerCase();
      const displayName = $("displayName").value.trim();
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        throw new Error("Юз: 3–24 символа, только буквы, цифры и _.");
      }
      const { data: existing } = await state.supabase
        .from("profiles").select("id").ilike("username", username).maybeSingle();
      if (existing) throw new Error("Этот юз уже занят.");

      const { data, error } = await state.supabase.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName } },
      });
      if (error) throw error;
      if (!data.session) {
        showToast("Аккаунт создан. Подтверди email, если Supabase попросил.", "success");
      }
    }
  } catch (error) {
    console.error(error);
    const message = String(error.message || error);
    if (message.toLowerCase().includes("database error")) {
      showToast("Не удалось создать аккаунт. Возможно, юз уже занят.", "error");
    } else {
      showToast(message, "error");
    }
  }
});

async function enterApp() {
  setScreen("appScreen");
  await loadMyProfile();
  await Promise.all([loadPeople(), loadConversations()]);
  await updatePresence();
  setInterval(updatePresence, 30000);
}

async function loadMyProfile() {
  const uid = state.session.user.id;
  const { data, error } = await state.supabase.from("profiles").select("*").eq("id", uid).single();
  if (error) throw error;
  state.me = data;
  state.profiles.set(data.id, data);
  renderMe();
}

async function signedAvatar(path) {
  if (!path) return null;
  const { data } = state.supabase.storage.from("egoria-avatars").getPublicUrl(path);
  return data.publicUrl;
}

async function renderAvatar(element, profile) {
  element.innerHTML = escapeHtml((profile.display_name || "Е")[0].toUpperCase());
  if (profile.avatar_path) {
    const url = await signedAvatar(profile.avatar_path);
    if (url) element.innerHTML = `<img src="${url}" alt="">`;
  }
}

function renderMe() {
  $("myName").textContent = state.me.display_name;
  $("myUsername").textContent = `@${state.me.username}`;
  renderAvatar($("myAvatar"), state.me);
}

async function loadPeople(query = "") {
  let request = state.supabase
    .from("profiles")
    .select("id,username,display_name,bio,avatar_path,last_seen")
    .neq("id", state.session.user.id)
    .order("display_name")
    .limit(50);
  if (query) request = request.or(`username.ilike.%${query}%,display_name.ilike.%${query}%`);
  const { data, error } = await request;
  if (error) {
    console.error(error);
    return;
  }
  data.forEach((profile) => state.profiles.set(profile.id, profile));
  renderPeople(data);
}

async function renderPeople(people) {
  const list = $("peopleList");
  list.innerHTML = "";
  for (const profile of people) {
    const button = document.createElement("button");
    button.className = "list-item";
    button.innerHTML = `
      <span class="avatar">${escapeHtml(profile.display_name[0].toUpperCase())}</span>
      <span class="item-copy">
        <strong>${escapeHtml(profile.display_name)}</strong>
        <small>@${escapeHtml(profile.username)}</small>
      </span>`;
    renderAvatar(button.querySelector(".avatar"), profile);
    button.onclick = () => startDirectChat(profile);
    list.appendChild(button);
  }
}

async function loadConversations() {
  const { data: memberships, error } = await state.supabase
    .from("conversation_members")
    .select("conversation_id,joined_at")
    .eq("user_id", state.session.user.id);
  if (error) {
    console.error(error);
    return;
  }
  const ids = memberships.map((m) => m.conversation_id);
  if (!ids.length) {
    state.conversations = [];
    renderChats();
    return;
  }
  const { data: conversations } = await state.supabase
    .from("conversations")
    .select("*")
    .in("id", ids)
    .eq("type", "direct")
    .order("updated_at", { ascending: false });

  const { data: allMembers } = await state.supabase
    .from("conversation_members")
    .select("conversation_id,user_id")
    .in("conversation_id", ids);

  state.conversations = (conversations || []).map((conversation) => {
    const member = allMembers?.find(
      (item) => item.conversation_id === conversation.id && item.user_id !== state.session.user.id
    );
    return { ...conversation, other_id: member?.user_id };
  }).filter((c) => c.other_id);
  renderChats();
}

async function renderChats() {
  const list = $("chatList");
  list.innerHTML = "";
  for (const conversation of state.conversations) {
    let profile = state.profiles.get(conversation.other_id);
    if (!profile) {
      const { data } = await state.supabase
        .from("profiles").select("id,username,display_name,bio,avatar_path,last_seen")
        .eq("id", conversation.other_id).single();
      profile = data;
      if (profile) state.profiles.set(profile.id, profile);
    }
    if (!profile) continue;
    const button = document.createElement("button");
    button.className = "list-item";
    button.innerHTML = `
      <span class="avatar">${escapeHtml(profile.display_name[0].toUpperCase())}</span>
      <span class="item-copy">
        <strong>${escapeHtml(profile.display_name)}</strong>
        <small>@${escapeHtml(profile.username)}</small>
      </span>`;
    renderAvatar(button.querySelector(".avatar"), profile);
    button.onclick = () => openConversation(conversation, profile);
    list.appendChild(button);
  }
}

async function startDirectChat(profile) {
  const currentUserId = state.session.user.id;
  const directKey = [currentUserId, profile.id].sort().join(":");

  try {
    // Сначала проверяем, существует ли уже такой личный чат.
    let { data: conversation, error: findError } = await state.supabase
      .from("conversations")
      .select("*")
      .eq("direct_key", directKey)
      .maybeSingle();

    if (findError) throw findError;

    if (!conversation) {
      // Создаём ID сами, чтобы не делать .select() сразу после INSERT.
      const conversationId = crypto.randomUUID();

      const { error: createError } = await state.supabase
        .from("conversations")
        .insert({
          id: conversationId,
          type: "direct",
          creator_id: currentUserId,
          direct_key: directKey,
        });

      if (createError) {
        // Возможно, второй пользователь одновременно создал такой же чат.
        if (createError.code === "23505") {
          const { data: existingConversation, error: retryError } =
            await state.supabase
              .from("conversations")
              .select("*")
              .eq("direct_key", directKey)
              .single();

          if (retryError) throw retryError;
          conversation = existingConversation;
        } else {
          throw createError;
        }
      } else {
        conversation = {
          id: conversationId,
          type: "direct",
          creator_id: currentUserId,
          direct_key: directKey,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }

      const { error: memberError } = await state.supabase
        .from("conversation_members")
        .upsert(
          [
            {
              conversation_id: conversation.id,
              user_id: currentUserId,
              role: "owner",
            },
            {
              conversation_id: conversation.id,
              user_id: profile.id,
              role: "member",
            },
          ],
          { onConflict: "conversation_id,user_id" }
        );

      if (memberError) throw memberError;
    }

    await loadConversations();
    openConversation(conversation, profile);
  } catch (error) {
    console.error("Ошибка создания личного чата:", error);
    showToast(error.message || "Не удалось открыть чат.", "error");
  }
}
async function openConversation(conversation, profile) {
  state.activeConversation = conversation;
  state.activeOther = profile;
  $("emptyChat").classList.add("hidden");
  $("chatView").classList.remove("hidden");
  $("appScreen").classList.add("chat-open");
  $("chatName").textContent = profile.display_name;
  renderAvatar($("chatAvatar"), profile);
  renderOnlineStatus(profile);
  await loadMessages();
  subscribeToMessages();
}

function renderOnlineStatus(profile) {
  const last = profile.last_seen ? new Date(profile.last_seen) : null;
  const online = last && Date.now() - last.getTime() < 70000;
  $("chatStatus").textContent = online ? "онлайн" : last ? `был(а) ${last.toLocaleString()}` : `@${profile.username}`;
}

async function loadMessages() {
  const { data, error } = await state.supabase
    .from("messages")
    .select("*, message_reactions(*)")
    .eq("conversation_id", state.activeConversation.id)
    .order("created_at");
  if (error) {
    showToast(error.message, "error");
    return;
  }
  state.messages = data || [];
  renderMessages();
}

async function attachmentUrl(message) {
  if (!message.attachment_path) return null;
  const { data, error } = await state.supabase.storage
    .from("egoria-files")
    .createSignedUrl(message.attachment_path, 3600);
  return error ? null : data.signedUrl;
}

async function renderMessages(filter = "") {
  const box = $("messages");
  box.innerHTML = "";
  const normalized = filter.trim().toLowerCase();
  for (const message of state.messages) {
    if (normalized && !(message.body || "").toLowerCase().includes(normalized)) continue;
    const mine = message.sender_id === state.session.user.id;
    const node = document.createElement("article");
    node.className = `message ${mine ? "mine" : ""} ${message.deleted_at ? "deleted" : ""}`;
    const body = message.deleted_at ? "Сообщение удалено" : escapeHtml(message.body || "");
    node.innerHTML = `
      <div class="message-body">${body}</div>
      <div class="attachment-slot"></div>
      <div class="reaction-row"></div>
      <div class="message-meta">
        ${message.edited_at ? "<span>изменено</span>" : ""}
        <time>${new Date(message.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time>
      </div>
      ${!message.deleted_at ? `<div class="message-actions">
        <button data-react="❤️" title="Реакция">♡</button>
        ${mine ? '<button data-edit title="Редактировать">✎</button><button data-delete title="Удалить">×</button>' : ""}
      </div>` : ""}`;
    if (message.attachment_path && !message.deleted_at) {
      const url = await attachmentUrl(message);
      const slot = node.querySelector(".attachment-slot");
      if (url && message.attachment_type?.startsWith("image/")) {
        slot.innerHTML = `<a href="${url}" target="_blank"><img class="message-image" src="${url}" alt=""></a>`;
      } else if (url) {
        slot.innerHTML = `<a class="file-card" href="${url}" target="_blank" download>📎 ${escapeHtml(message.attachment_name || "Скачать файл")}</a>`;
      }
    }
    renderReactions(node.querySelector(".reaction-row"), message);
    node.querySelector("[data-react]")?.addEventListener("click", () => toggleReaction(message.id, "❤️"));
    node.querySelector("[data-edit]")?.addEventListener("click", () => beginEdit(message));
    node.querySelector("[data-delete]")?.addEventListener("click", () => deleteMessage(message));
    box.appendChild(node);
  }
  if (!filter) box.scrollTop = box.scrollHeight;
}

function renderReactions(container, message) {
  const grouped = new Map();
  (message.message_reactions || []).forEach((reaction) => {
    const item = grouped.get(reaction.emoji) || { count: 0, mine: false };
    item.count += 1;
    if (reaction.user_id === state.session.user.id) item.mine = true;
    grouped.set(reaction.emoji, item);
  });
  container.innerHTML = [...grouped.entries()].map(([emoji, info]) =>
    `<button class="reaction ${info.mine ? "mine" : ""}" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)} ${info.count}</button>`
  ).join("");
  container.querySelectorAll("[data-emoji]").forEach((button) => {
    button.onclick = () => toggleReaction(message.id, button.dataset.emoji);
  });
}

async function toggleReaction(messageId, emoji) {
  const message = state.messages.find((item) => item.id === messageId);
  const existing = message?.message_reactions?.find(
    (reaction) => reaction.user_id === state.session.user.id && reaction.emoji === emoji
  );
  const query = existing
    ? state.supabase.from("message_reactions").delete().eq("message_id", messageId).eq("user_id", state.session.user.id).eq("emoji", emoji)
    : state.supabase.from("message_reactions").insert({ message_id: messageId, user_id: state.session.user.id, emoji });
  const { error } = await query;
  if (error) showToast(error.message, "error");
  else await loadMessages();
}

function beginEdit(message) {
  state.editingMessageId = message.id;
  $("editMessageText").value = message.body || "";
  $("editMessageDialog").showModal();
}

$("editMessageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("editMessageText").value.trim();
  const { error } = await state.supabase
    .from("messages")
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", state.editingMessageId);
  if (error) showToast(error.message, "error");
  else {
    $("editMessageDialog").close();
    await loadMessages();
  }
});

async function deleteMessage(message) {
  if (!confirm("Удалить это сообщение?")) return;
  const { error } = await state.supabase
    .from("messages")
    .update({
      body: "",
      attachment_path: null,
      attachment_name: null,
      attachment_type: null,
      attachment_size: null,
      deleted_at: new Date().toISOString(),
    })
    .eq("id", message.id);
  if (error) showToast(error.message, "error");
  else await loadMessages();
}

$("messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeConversation) return;
  const body = $("messageInput").value.trim();
  const file = $("attachmentInput").files[0];
  if (!body && !file) return;

  let attachment = {};
  try {
    if (file) {
      if (file.size > 25 * 1024 * 1024) throw new Error("Максимальный размер файла — 25 МБ.");
      const safeName = file.name.replace(/[^a-zA-Z0-9а-яА-Я._-]/g, "_");
      const path = `${state.session.user.id}/${state.activeConversation.id}/${crypto.randomUUID()}-${safeName}`;
      const { error } = await state.supabase.storage.from("egoria-files").upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (error) throw error;
      attachment = {
        attachment_path: path,
        attachment_name: file.name,
        attachment_type: file.type || "application/octet-stream",
        attachment_size: file.size,
      };
    }

    const { error } = await state.supabase.from("messages").insert({
      conversation_id: state.activeConversation.id,
      sender_id: state.session.user.id,
      body,
      ...attachment,
    });
    if (error) throw error;

    await state.supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", state.activeConversation.id);

    $("messageInput").value = "";
    $("attachmentInput").value = "";
    $("attachmentPreview").classList.add("hidden");
    await loadMessages();
  } catch (error) {
    showToast(error.message, "error");
  }
});

function cleanupRealtime() {
  if (state.realtimeChannel && state.supabase) {
    state.supabase.removeChannel(state.realtimeChannel);
    state.realtimeChannel = null;
  }
}

function subscribeToMessages() {
  cleanupRealtime();
  state.realtimeChannel = state.supabase
    .channel(`conversation-${state.activeConversation.id}`)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "messages",
      filter: `conversation_id=eq.${state.activeConversation.id}`,
    }, () => loadMessages())
    .on("postgres_changes", {
      event: "*", schema: "public", table: "message_reactions",
    }, () => loadMessages())
    .subscribe();
}

async function updatePresence() {
  if (!state.session) return;
  await state.supabase.from("profiles")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", state.session.user.id);
}

$("profileBtn").onclick = () => {
  $("profileName").value = state.me.display_name;
  $("profileBio").value = state.me.bio || "";
  $("profileAvatar").value = "";
  $("profileDialog").showModal();
};

$("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = $("profileName").value.trim();
  const bio = $("profileBio").value.trim();
  const avatar = $("profileAvatar").files[0];
  try {
    let avatarPath = state.me.avatar_path;
    if (avatar) {
      if (avatar.size > 5 * 1024 * 1024) throw new Error("Аватар должен быть меньше 5 МБ.");
      const ext = avatar.name.split(".").pop()?.toLowerCase() || "jpg";
      avatarPath = `${state.session.user.id}/avatar-${Date.now()}.${ext}`;
      const { error } = await state.supabase.storage.from("egoria-avatars").upload(avatarPath, avatar, {
        upsert: true,
        contentType: avatar.type,
      });
      if (error) throw error;
    }
    const { error } = await state.supabase.from("profiles")
      .update({ display_name: displayName, bio, avatar_path: avatarPath })
      .eq("id", state.session.user.id);
    if (error) throw error;
    $("profileDialog").close();
    await loadMyProfile();
    await loadPeople($("userSearch").value.trim());
    showToast("Профиль сохранён.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
});

$("logoutBtn").onclick = () => state.supabase.auth.signOut();
$("closeProfile").onclick = () => $("profileDialog").close();
$("closeEditMessage").onclick = () => $("editMessageDialog").close();
$("mobileBack").onclick = () => $("appScreen").classList.remove("chat-open");

$("attachmentInput").onchange = () => {
  const file = $("attachmentInput").files[0];
  if (!file) return $("attachmentPreview").classList.add("hidden");
  $("attachmentPreview").textContent = `Прикреплён: ${file.name} — ${(file.size / 1024 / 1024).toFixed(2)} МБ`;
  $("attachmentPreview").classList.remove("hidden");
};

$("messageInput").addEventListener("input", () => {
  const input = $("messageInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
});
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("messageForm").requestSubmit();
  }
});

$("userSearch").addEventListener("input", () => loadPeople($("userSearch").value.trim()));
$("chatsTab").onclick = () => switchSideTab("chats");
$("peopleTab").onclick = () => switchSideTab("people");
function switchSideTab(tab) {
  $("chatsTab").classList.toggle("active", tab === "chats");
  $("peopleTab").classList.toggle("active", tab === "people");
  $("chatList").classList.toggle("hidden", tab !== "chats");
  $("peopleList").classList.toggle("hidden", tab !== "people");
}

$("searchMessagesBtn").onclick = () => {
  $("messageSearchBar").classList.remove("hidden");
  $("messageSearch").focus();
};
$("closeMessageSearch").onclick = () => {
  $("messageSearch").value = "";
  $("messageSearchBar").classList.add("hidden");
  renderMessages();
};
$("messageSearch").oninput = () => renderMessages($("messageSearch").value);

$("themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("egoria_theme", next);
};
function applySavedTheme() {
  document.documentElement.dataset.theme = localStorage.getItem("egoria_theme") || "dark";
}

boot();
