const STORAGE_KEYS = {
  content: "mobile-cache-mvp.content-db.v2",
  user: "mobile-cache-mvp.user-db.v2",
};

const seedContentDb = {
  schema: "mobile-cache-mvp.content-db.v1",
  updated_at: "2026-04-29T00:00:00.000Z",
  conversations: {},
  conversation_index: [],
};

const seedUserDb = {
  schema: "mobile-cache-mvp.user-db.v1",
  updated_at: "2026-04-29T00:00:00.000Z",
  active_profile_id: "local-profile",
  profiles: {
    "local-profile": {
      id: "local-profile",
      display_name: "Local Phone User",
      provider: "openai",
      openai: {
        api_key: "",
        model: "gpt-4.1-mini",
        vector_store_id: "",
      },
      script: {
        id: "mobile-context-reply",
        name: "Mobile context reply",
        system_prompt: "You are a careful assistant. Use the provided local context when it is relevant.",
        context_node_limit: 6,
      },
    },
  },
};

const els = {
  providerLine: document.querySelector("#providerLine"),
  exportButton: document.querySelector("#exportButton"),
  resetButton: document.querySelector("#resetButton"),
  profileForm: document.querySelector("#profileForm"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  modelInput: document.querySelector("#modelInput"),
  vectorStoreInput: document.querySelector("#vectorStoreInput"),
  systemPromptInput: document.querySelector("#systemPromptInput"),
  profileStatus: document.querySelector("#profileStatus"),
  conversationTitle: document.querySelector("#conversationTitle"),
  statusLine: document.querySelector("#statusLine"),
  messageStack: document.querySelector("#messageStack"),
  runForm: document.querySelector("#runForm"),
  inputBox: document.querySelector("#inputBox"),
  runButton: document.querySelector("#runButton"),
  editDialog: document.querySelector("#editDialog"),
  editPromptInput: document.querySelector("#editPromptInput"),
  saveEditButton: document.querySelector("#saveEditButton"),
};

let contentDb = loadLocal(STORAGE_KEYS.content) || structuredCopy(seedContentDb);
let userDb = loadLocal(STORAGE_KEYS.user) || structuredCopy(seedUserDb);
let activeConversationId = firstConversationId();
let editingNodeId = null;

els.profileForm.addEventListener("submit", saveProfile);
els.runForm.addEventListener("submit", runScript);
els.exportButton.addEventListener("click", exportDatabases);
els.resetButton.addEventListener("click", resetLocalDatabases);
els.saveEditButton.addEventListener("click", savePromptVersion);

persistAll();
render();
setStatus("ready");

function render() {
  const profile = activeProfile();
  const openai = profile.openai || {};
  els.providerLine.textContent = [
    profile.provider || "openai",
    openai.model || "no model",
    openai.api_key ? "key set" : "no key",
    openai.vector_store_id ? "vector" : "no vector",
  ].join(" · ");
  els.modelInput.value = openai.model || "";
  els.vectorStoreInput.value = openai.vector_store_id || "";
  els.systemPromptInput.value = profile.script?.system_prompt || "";
  const conversation = activeConversation();
  els.conversationTitle.textContent = conversation?.title || "空内容库";
  renderMessages(conversation);
}

function renderMessages(conversation) {
  els.messageStack.replaceChildren();
  if (!conversation) {
    const empty = document.createElement("article");
    empty.className = "message";
    empty.innerHTML = '<div class="message-meta">empty</div><div class="message-text">内容库现在是空的。输入一条 prompt 后会自动创建第一条 conversation。</div>';
    els.messageStack.append(empty);
    return;
  }
  for (const node of currentPath(conversation).filter((item) => item.message)) {
    els.messageStack.append(renderMessage(conversation, node));
  }
}

function renderMessage(conversation, node) {
  const role = node.message.author?.role || "unknown";
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role;
  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = contentToText(node.message.content);
  article.append(meta, text);
  if (role === "user") article.append(renderPromptToolbar(conversation, node));
  return article;
}

function renderPromptToolbar(conversation, node) {
  const toolbar = document.createElement("div");
  toolbar.className = "prompt-toolbar";
  const copyButton = iconButton("⧉", "复制 prompt");
  copyButton.addEventListener("click", () => navigator.clipboard?.writeText(contentToText(node.message.content)));
  const editButton = iconButton("✎", "编辑 prompt");
  editButton.addEventListener("click", () => openPromptEditor(node.id));
  const versions = promptVersions(conversation, node);
  const index = versions.findIndex((item) => item.id === node.id);
  const previousButton = iconButton("‹", "上一个版本");
  const nextButton = iconButton("›", "下一个版本");
  const versionLabel = document.createElement("span");
  versionLabel.className = "version-label";
  versionLabel.textContent = `${index + 1}/${versions.length}`;
  previousButton.disabled = index <= 0;
  nextButton.disabled = index >= versions.length - 1;
  previousButton.addEventListener("click", () => switchPromptVersion(conversation, versions[index - 1]?.id));
  nextButton.addEventListener("click", () => switchPromptVersion(conversation, versions[index + 1]?.id));
  toolbar.append(copyButton, editButton, previousButton, versionLabel, nextButton);
  return toolbar;
}

function openPromptEditor(nodeId) {
  editingNodeId = nodeId;
  els.editPromptInput.value = contentToText(activeConversation().mapping[nodeId].message.content);
  els.editDialog.showModal();
}

function savePromptVersion() {
  const conversation = activeConversation();
  const original = conversation.mapping[editingNodeId];
  const text = els.editPromptInput.value.trim();
  if (!original || !text) return;
  const nodeId = `user-${crypto.randomUUID()}`;
  const parentId = original.parent || null;
  conversation.mapping[nodeId] = {
    id: nodeId,
    parent: parentId,
    children: [],
    message: createMessage("user", text, Date.now() / 1000, null),
    node_metadata: { created_by: "prompt-editor", version_of: editingNodeId },
  };
  if (parentId && conversation.mapping[parentId]) {
    conversation.mapping[parentId].children = unique([...(conversation.mapping[parentId].children || []), nodeId]);
  }
  conversation.current_node = nodeId;
  touchContentDb(conversation);
  persistAll();
  els.editDialog.close();
  render();
  setStatus("prompt version saved");
}

function switchPromptVersion(conversation, nodeId) {
  if (!nodeId) return;
  conversation.current_node = latestDescendant(conversation, nodeId);
  touchContentDb(conversation);
  persistAll();
  render();
}

async function runScript(event) {
  event.preventDefault();
  const input = els.inputBox.value.trim();
  if (!input) return setStatus("input is empty");
  const profile = activeProfile();
  const openai = profile.openai || {};
  if (!openai.api_key) return setStatus("missing API key");
  if (!openai.model) return setStatus("missing model");
  const conversation = activeConversation();
  const targetConversation = conversation || createEmptyConversation();
  const userNode = appendNode(targetConversation, "user", input, null);
  targetConversation.current_node = userNode.id;
  touchContentDb(targetConversation);
  persistAll();
  render();
  els.runButton.disabled = true;
  setStatus("calling OpenAI");
  try {
    const output = await callOpenAI({
      apiKey: openai.api_key,
      model: openai.model,
      vectorStoreId: openai.vector_store_id || "",
      systemPrompt: profile.script?.system_prompt || "",
      context: buildContext(targetConversation, profile.script?.context_node_limit || 6),
      input,
    });
    const assistantNode = appendNode(targetConversation, "assistant", output, openai.model);
    targetConversation.current_node = assistantNode.id;
    touchContentDb(targetConversation);
    persistAll();
    els.inputBox.value = "";
    render();
    setStatus("reply saved");
  } catch (error) {
    setStatus(`call failed: ${error.message}`);
  } finally {
    els.runButton.disabled = false;
  }
}

async function callOpenAI({ apiKey, model, vectorStoreId, systemPrompt, context, input }) {
  const payload = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Local context:\n${context || "(empty)"}\n\nUser input:\n${input}` },
    ],
  };
  if (vectorStoreId) payload.tools = [{ type: "file_search", vector_store_ids: [vectorStoreId] }];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data.output_text || (data.output || []).flatMap((item) => item.content || []).map((part) => part.text).filter(Boolean).join("\n") || "(empty response)";
}

function appendNode(conversation, role, text, model) {
  const parentId = conversation.current_node || null;
  const nodeId = `${role}-${crypto.randomUUID()}`;
  const node = {
    id: nodeId,
    parent: parentId,
    children: [],
    message: createMessage(role, text, Date.now() / 1000, model),
    node_metadata: { created_by: "mobile-cache-mvp" },
  };
  conversation.mapping[nodeId] = node;
  if (parentId && conversation.mapping[parentId]) {
    conversation.mapping[parentId].children = unique([...(conversation.mapping[parentId].children || []), nodeId]);
  }
  return node;
}

function createMessage(role, text, time, model) {
  return {
    id: `message-${crypto.randomUUID()}`,
    author: { role, name: null, metadata: {} },
    content: { content_type: "text", parts: [text] },
    create_time: time,
    update_time: null,
    status: "finished_successfully",
    end_turn: role === "assistant",
    weight: 1,
    channel: null,
    recipient: null,
    metadata: model ? { model_slug: model, message_type: "next" } : { message_type: "next" },
  };
}

function currentPath(conversation) {
  const path = [];
  const seen = new Set();
  let nodeId = conversation.current_node;
  while (nodeId && conversation.mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    path.push(conversation.mapping[nodeId]);
    nodeId = conversation.mapping[nodeId].parent;
  }
  return path.reverse();
}

function promptVersions(conversation, node) {
  const parentId = node.parent;
  if (!parentId || !conversation.mapping[parentId]) return [node];
  return (conversation.mapping[parentId].children || [])
    .map((id) => conversation.mapping[id])
    .filter((item) => item?.message?.author?.role === "user");
}

function latestDescendant(conversation, nodeId) {
  let current = nodeId;
  const seen = new Set();
  while (current && conversation.mapping[current] && !seen.has(current)) {
    seen.add(current);
    const children = conversation.mapping[current].children || [];
    if (!children.length) break;
    current = children[children.length - 1];
  }
  return current;
}

function buildContext(conversation, limit) {
  return currentPath(conversation)
    .filter((node) => node.message)
    .slice(-limit)
    .map((node) => `${node.message.author?.role || "unknown"}: ${contentToText(node.message.content)}`)
    .join("\n\n---\n\n");
}

function contentToText(content) {
  if (!content) return "";
  if (content.content_type === "text" && Array.isArray(content.parts)) {
    return content.parts.filter((part) => typeof part === "string").join("\n");
  }
  return `[unsupported:${content.content_type || "content"}]`;
}

function saveProfile(event) {
  event.preventDefault();
  const profile = activeProfile();
  profile.openai ||= {};
  const apiKey = els.apiKeyInput.value.trim();
  if (apiKey) profile.openai.api_key = apiKey;
  profile.openai.model = els.modelInput.value.trim();
  profile.openai.vector_store_id = els.vectorStoreInput.value.trim();
  profile.script ||= {};
  profile.script.system_prompt = els.systemPromptInput.value.trim();
  userDb.updated_at = new Date().toISOString();
  persistAll();
  els.apiKeyInput.value = "";
  els.profileStatus.textContent = "saved in browser storage";
  render();
}

function exportDatabases() {
  const payload = { exported_at: new Date().toISOString(), contentDb, userDb: maskUserDb(userDb) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mobile-cache-mvp-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("exported");
}

function maskUserDb(value) {
  const copy = structuredCopy(value);
  for (const profile of Object.values(copy.profiles || {})) {
    if (profile.openai?.api_key) profile.openai.api_key = "[redacted]";
  }
  return copy;
}

function resetLocalDatabases() {
  if (!window.confirm("Reload sample data and clear this page's browser-local MVP data?")) return;
  contentDb = structuredCopy(seedContentDb);
  userDb = structuredCopy(seedUserDb);
  activeConversationId = firstConversationId();
  persistAll();
  render();
  setStatus("sample reloaded");
}

function touchContentDb(conversation) {
  conversation.update_time = Date.now() / 1000;
  contentDb.updated_at = new Date().toISOString();
  const preview = contentToText(conversation.mapping[conversation.current_node]?.message?.content).replace(/\s+/g, " ").slice(0, 160);
  const record = {
    id: conversation.id,
    title: conversation.title,
    create_time: conversation.create_time,
    update_time: conversation.update_time,
    current_node: conversation.current_node,
    default_model_slug: conversation.default_model_slug,
    preview_text: preview,
    is_archived: conversation.is_archived ?? null,
    is_starred: conversation.is_starred ?? null,
    source_kind: conversation.source?.kind,
    has_unsupported_content: false,
  };
  const index = contentDb.conversation_index || [];
  const existing = index.findIndex((item) => item.id === conversation.id);
  if (existing >= 0) index[existing] = record;
  else index.push(record);
  contentDb.conversation_index = index;
}

function iconButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "prompt-icon";
  button.textContent = label;
  button.title = title;
  return button;
}

function firstConversationId() {
  return contentDb.conversation_index?.[0]?.id || Object.keys(contentDb.conversations || {})[0];
}

function activeConversation() {
  return contentDb.conversations?.[activeConversationId] || null;
}

function createEmptyConversation() {
  const now = Date.now() / 1000;
  const id = `conversation-${crypto.randomUUID()}`;
  const conversation = {
    id,
    conversation_id: id,
    title: "手机网页测试",
    create_time: now,
    update_time: now,
    current_node: null,
    default_model_slug: activeProfile().openai?.model || "gpt-4.1-mini",
    mapping: {},
    metadata: { provider: "openai", adapter_version: "mobile-cache-mvp" },
    source: { kind: "created_in_mobile_cache_mvp" },
  };
  contentDb.conversations[id] = conversation;
  activeConversationId = id;
  touchContentDb(conversation);
  return conversation;
}

function activeProfile() {
  return userDb.profiles[userDb.active_profile_id];
}

function persistAll() {
  localStorage.setItem(STORAGE_KEYS.content, JSON.stringify(contentDb));
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(userDb));
}

function loadLocal(key) {
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) : null;
}

function structuredCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function setStatus(message) {
  els.statusLine.textContent = message;
}
