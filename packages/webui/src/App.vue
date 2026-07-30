<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { NIcon, NSelect } from "naive-ui";
import {
  AddOutline,
  CheckmarkCircle,
  ChevronDownOutline,
  CloudDoneOutline,
  CodeSlashOutline,
  EyeOffOutline,
  EyeOutline,
  HardwareChipOutline,
  HelpCircleOutline,
  ImageOutline,
  KeyOutline,
  LogoWechat,
  PeopleOutline,
  PersonOutline,
  PulseOutline,
  RefreshOutline,
  SaveOutline,
  ServerOutline,
  SettingsOutline,
  SparklesOutline,
  TrashOutline,
  VideocamOutline,
  VolumeHighOutline,
} from "@vicons/ionicons5";

type ScopeMode = "whitelist" | "blacklist";
type Scope = { mode: ScopeMode; ids: string[] };
type ProviderType = "anthropic" | "deepseek" | "openai-compatible" | "openai";
type Provider = {
  name: string;
  type: ProviderType;
  options: { base_url: string; api_key: string };
  models: { id: string; alias: string }[];
};
type AppConfig = {
  napcat: {
    qq_id: string;
    ws_url: string;
    token: string;
    groups: Scope;
    private_chats: Scope;
    group_members: Scope;
  };
  models: {
    plan: string;
    reply: string;
    main: string;
    multimodal_image: string;
    multimodal_video: string;
    multimodal_audio: string;
  };
  providers: Provider[];
};

const defaultConfig: AppConfig = {
  napcat: {
    qq_id: "2870245624",
    ws_url: "",
    token: "",
    groups: { mode: "whitelist" as ScopeMode, ids: ["123456789", "987654321"] },
    private_chats: { mode: "whitelist" as ScopeMode, ids: ["123456789"] },
    group_members: { mode: "blacklist" as ScopeMode, ids: [] },
  },
  models: {
    plan: "deepseek-v4-flash",
    reply: "deepseek-v4-pro",
    main: "deepseek-v4-flash",
    multimodal_image: "mimo-v2.5",
    multimodal_video: "mimo-v2.5",
    multimodal_audio: "mimo-v2.5",
  },
  providers: [
    {
      name: "deepseek",
      type: "anthropic" as ProviderType,
      options: { base_url: "https://api.deepseek.com", api_key: "sk-xxxx" },
      models: [
        { id: "deepseek-v4-flash", alias: "deepseek-v4-flash" },
        { id: "deepseek-v4-pro", alias: "deepseek-v4-pro" },
      ],
    },
    {
      name: "openai-compatible",
      type: "openai-compatible" as ProviderType,
      options: { base_url: "https://api.xiaomimimo.com/v1", api_key: "sk-xxxx" },
      models: [{ id: "mimo-v2.5", alias: "mimo-v2.5" }],
    },
  ] as Provider[],
};

const config = reactive<AppConfig>(structuredClone(defaultConfig));
const activeSection = ref("quick-start");
const advancedOpen = ref(false);
const showKeys = reactive<Record<number, boolean>>({});
const idDrafts = reactive<Record<string, string>>({});
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
const saveError = ref("");
const loadingProviders = reactive<Record<number, boolean>>({});
const providerErrors = reactive<Record<number, string>>({});
const providerModelOptions = reactive<Record<number, string[]>>({});
const initialized = ref(false);
let sectionObserver: IntersectionObserver | undefined;

const navItems = [
  { id: "quick-start", label: "快速开始", icon: SparklesOutline },
  { id: "access", label: "聊天权限", icon: PeopleOutline },
  { id: "models", label: "模型分工", icon: HardwareChipOutline },
  { id: "providers", label: "模型供应商", icon: ServerOutline },
];

const modelOptions = computed(() =>
  config.providers
    .flatMap((provider) => provider.models.map((model) => model.alias))
    .filter((alias, index, all) => all.indexOf(alias) === index),
);
const configuredKeys = computed(
  () =>
    config.providers.filter((provider) => provider.options.api_key && provider.options.api_key !== "sk-xxxx").length,
);
const completion = computed(() => {
  const checks = [
    Boolean(config.napcat.qq_id),
    configuredKeys.value === config.providers.length,
    modelOptions.value.length > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
});

const modelRoles = computed(() => [
  { key: "plan" as const, title: "规划模型", description: "负责理解问题、拆解任务", icon: PulseOutline, tone: "blue" },
  { key: "reply" as const, title: "回复模型", description: "负责组织最终回答", icon: SparklesOutline, tone: "violet" },
  {
    key: "main" as const,
    title: "单 Agent 主模型",
    description: "启用时独立完成规划与回复",
    icon: HardwareChipOutline,
    tone: "green",
  },
  {
    key: "multimodal_image" as const,
    title: "图像理解",
    description: "识别图片与截图内容",
    icon: ImageOutline,
    tone: "orange",
  },
  {
    key: "multimodal_video" as const,
    title: "视频理解",
    description: "分析视频输入",
    icon: VideocamOutline,
    tone: "red",
  },
  {
    key: "multimodal_audio" as const,
    title: "音频理解",
    description: "处理语音与音频",
    icon: VolumeHighOutline,
    tone: "cyan",
  },
]);

function scrollToSection(id: string) {
  activeSection.value = id;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function addId(scopeName: "groups" | "private_chats" | "group_members") {
  const value = idDrafts[scopeName]?.trim();
  if (!value || config.napcat[scopeName].ids.includes(value)) return;
  config.napcat[scopeName].ids.push(value);
  idDrafts[scopeName] = "";
}

function addProvider() {
  config.providers.push({
    name: `provider-${config.providers.length + 1}`,
    type: "openai-compatible",
    options: { base_url: "https://api.example.com/v1", api_key: "" },
    models: [{ id: "", alias: "" }],
  });
  requestAnimationFrame(() =>
    document.getElementById(`provider-${config.providers.length - 1}`)?.scrollIntoView({ behavior: "smooth" }),
  );
}

async function saveConfig() {
  saveState.value = "saving";
  saveError.value = "";
  try {
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.error?.message ?? "保存失败，请稍后重试");
    saveState.value = "saved";
    window.setTimeout(() => (saveState.value = "idle"), 2400);
  } catch (error) {
    saveState.value = "error";
    saveError.value = error instanceof Error ? error.message : "保存失败，请稍后重试";
  }
}

async function fetchProviderModels(providerIndex: number) {
  const provider = config.providers[providerIndex];
  loadingProviders[providerIndex] = true;
  providerErrors[providerIndex] = "";
  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: provider.type,
        base_url: provider.options.base_url,
        api_key: provider.options.api_key,
      }),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.error?.message ?? "获取模型失败");
    const discoveredModels = (payload?.models as unknown[] | undefined)?.filter(
      (id): id is string => typeof id === "string",
    );
    if (!discoveredModels?.length) {
      providerErrors[providerIndex] = "供应商没有返回可用模型";
      return;
    }
    providerModelOptions[providerIndex] = discoveredModels;
  } catch (error) {
    providerErrors[providerIndex] = error instanceof Error ? error.message : "获取模型失败";
  } finally {
    loadingProviders[providerIndex] = false;
  }
}

function getProviderModelOptions(providerIndex: number, currentId: string) {
  return [...new Set([currentId, ...(providerModelOptions[providerIndex] ?? [])].filter(Boolean))].map((id) => ({
    label: id,
    value: id,
  }));
}

onMounted(async () => {
  sectionObserver = new IntersectionObserver(
    (entries) => {
      const currentSection = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
        .at(0);
      if (currentSection) activeSection.value = currentSection.target.id;
    },
    { rootMargin: "-130px 0px -65% 0px" },
  );
  navItems
    .map(({ id }) => document.getElementById(id))
    .forEach((section) => section && sectionObserver?.observe(section));

  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const incoming = await response.json();
      if (incoming?.napcat && incoming?.models && Array.isArray(incoming?.providers)) Object.assign(config, incoming);
    }
  } catch {
    // 开发预览没有后端时使用示例配置。
  } finally {
    initialized.value = true;
  }
});

onUnmounted(() => sectionObserver?.disconnect());

watch(
  config,
  () => {
    if (initialized.value && saveState.value === "saved") saveState.value = "idle";
  },
  { deep: true },
);
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><n-icon :component="SparklesOutline" /></div>
        <div><strong>mita core</strong><span>配置工作台</span></div>
      </div>

      <nav class="side-nav" aria-label="配置导航">
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="{ active: activeSection === item.id }"
          @click="scrollToSection(item.id)"
        >
          <n-icon :component="item.icon" /><span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="sidebar-note">
        <n-icon :component="HelpCircleOutline" />
        <div>
          <strong>第一次配置？</strong>
          <p>只需填写 QQ 号和 API Key，其他选项可以暂时保持默认。</p>
        </div>
      </div>
      <div class="version">Mita Core · 本地配置</div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div>
          <p class="eyebrow">CONFIGURATION</p>
          <h1>让你的机器人准备就绪</h1>
        </div>
        <div class="top-actions">
          <span class="local-badge"><i></i> 数据仅保存在本机</span>
          <button class="save-button" :class="saveState" :disabled="saveState === 'saving'" @click="saveConfig">
            <n-icon :component="saveState === 'saved' ? CheckmarkCircle : SaveOutline" />
            {{
              saveState === "saving"
                ? "正在保存"
                : saveState === "saved"
                  ? "已保存"
                  : saveState === "error"
                    ? "重试保存"
                    : "保存配置"
            }}
          </button>
        </div>
      </header>
      <div v-if="saveError" class="save-error" role="alert">{{ saveError }}</div>

      <div class="mobile-nav">
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="{ active: activeSection === item.id }"
          @click="scrollToSection(item.id)"
        >
          {{ item.label }}
        </button>
      </div>

      <div class="content-grid">
        <div class="form-column">
          <section id="quick-start" class="section-block hero-card">
            <div class="hero-copy">
              <span class="step-label">第 1 步，共 3 步</span>
              <h2>先连接机器人 QQ</h2>
              <p>填写专门用于机器人的 QQ 账号。启动 mita core 后，内置服务会引导你完成登录。</p>
              <label class="field-label" for="qq-id">机器人 QQ 号</label>
              <div class="input-with-icon large">
                <n-icon :component="LogoWechat" />
                <input id="qq-id" v-model="config.napcat.qq_id" inputmode="numeric" placeholder="请输入机器人 QQ 号" />
                <span v-if="config.napcat.qq_id" class="valid-mark"
                  ><n-icon :component="CheckmarkCircle" /> 已填写</span
                >
              </div>
              <p class="field-help">请使用单独注册的机器人账号，不要填写你自己的常用 QQ。</p>

              <button class="advanced-toggle" @click="advancedOpen = !advancedOpen">
                <n-icon :component="SettingsOutline" /> 高级连接设置
                <n-icon class="chevron" :class="{ open: advancedOpen }" :component="ChevronDownOutline" />
              </button>
              <div v-if="advancedOpen" class="advanced-fields">
                <label
                  ><span>WebSocket 地址</span><input v-model="config.napcat.ws_url" placeholder="ws://localhost:3001"
                /></label>
                <label
                  ><span>服务 Token</span
                  ><input v-model="config.napcat.token" type="password" placeholder="仅外部 NapCat 需要"
                /></label>
              </div>
            </div>
            <div class="connection-visual" aria-hidden="true">
              <div class="signal signal-one"></div>
              <div class="signal signal-two"></div>
              <div class="bot-orbit"><n-icon :component="LogoWechat" /></div>
              <span class="visual-label">等待启动后登录</span>
            </div>
          </section>

          <section id="access" class="section-block">
            <div class="section-heading">
              <div>
                <span class="step-label">第 2 步，共 3 步</span>
                <h2>谁可以和机器人聊天？</h2>
                <p>推荐使用白名单，只允许你明确添加的群或用户触发机器人。</p>
              </div>
              <span class="recommend-badge">推荐：白名单</span>
            </div>

            <div class="scope-grid">
              <article
                v-for="scope in [
                  {
                    key: 'groups' as const,
                    title: '群聊',
                    description: '允许哪些群使用机器人',
                    icon: PeopleOutline,
                    placeholder: '输入群号',
                  },
                  {
                    key: 'private_chats' as const,
                    title: '私聊',
                    description: '允许哪些用户发起私聊',
                    icon: PersonOutline,
                    placeholder: '输入 QQ 号',
                  },
                  {
                    key: 'group_members' as const,
                    title: '群成员',
                    description: '在允许的群中进一步限制成员',
                    icon: KeyOutline,
                    placeholder: '输入成员 QQ 号',
                  },
                ]"
                :key="scope.key"
                class="scope-card"
              >
                <div class="card-title">
                  <span class="icon-box"><n-icon :component="scope.icon" /></span>
                  <div>
                    <h3>{{ scope.title }}</h3>
                    <p>{{ scope.description }}</p>
                  </div>
                </div>
                <div class="segmented">
                  <button
                    :class="{ active: config.napcat[scope.key].mode === 'whitelist' }"
                    @click="config.napcat[scope.key].mode = 'whitelist'"
                  >
                    白名单
                  </button>
                  <button
                    :class="{ active: config.napcat[scope.key].mode === 'blacklist' }"
                    @click="config.napcat[scope.key].mode = 'blacklist'"
                  >
                    黑名单
                  </button>
                </div>
                <div class="tag-list">
                  <span v-for="id in config.napcat[scope.key].ids" :key="id"
                    >{{ id
                    }}<button
                      :aria-label="`删除 ${id}`"
                      @click="config.napcat[scope.key].ids = config.napcat[scope.key].ids.filter((item) => item !== id)"
                    >
                      ×
                    </button></span
                  >
                  <em v-if="!config.napcat[scope.key].ids.length">当前列表为空</em>
                </div>
                <div class="inline-add">
                  <input
                    v-model="idDrafts[scope.key]"
                    :placeholder="scope.placeholder"
                    @keyup.enter="addId(scope.key)"
                  />
                  <button title="添加" @click="addId(scope.key)"><n-icon :component="AddOutline" /></button>
                </div>
              </article>
            </div>
          </section>

          <section id="models" class="section-block">
            <div class="section-heading">
              <div>
                <span class="step-label">第 3 步，共 3 步</span>
                <h2>给模型安排工作</h2>
                <p>从供应商提供的模型中，为不同任务选择合适的角色。</p>
              </div>
            </div>
            <div class="role-list">
              <label v-for="role in modelRoles" :key="role.key" class="role-row">
                <span class="role-icon" :class="role.tone"><n-icon :component="role.icon" /></span>
                <span class="role-copy"
                  ><strong>{{ role.title }}</strong
                  ><small>{{ role.description }}</small></span
                >
                <span class="select-wrap"
                  ><select v-model="config.models[role.key]">
                    <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option></select
                  ><n-icon :component="ChevronDownOutline"
                /></span>
              </label>
            </div>
          </section>

          <section id="providers" class="section-block">
            <div class="section-heading provider-heading">
              <div>
                <p class="eyebrow">MODEL PROVIDERS</p>
                <h2>模型供应商</h2>
                <p>配置 API 地址和密钥，再登记这个供应商提供的模型。</p>
              </div>
              <button class="secondary-button" @click="addProvider">
                <n-icon :component="AddOutline" /> 添加供应商
              </button>
            </div>

            <article
              v-for="(provider, providerIndex) in config.providers"
              :id="`provider-${providerIndex}`"
              :key="providerIndex"
              class="provider-card"
            >
              <div class="provider-top">
                <span class="provider-logo"
                  ><n-icon :component="provider.type === 'deepseek' ? CodeSlashOutline : CloudDoneOutline"
                /></span>
                <label><span>显示名称</span><input v-model="provider.name" /></label>
                <label
                  ><span>端点类型</span
                  ><span class="select-wrap"
                    ><select v-model="provider.type">
                      <option value="anthropic">Anthropic</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="openai-compatible">OpenAI Compatible</option>
                      <option value="openai">OpenAI Responses</option></select
                    ><n-icon :component="ChevronDownOutline" /></span
                ></label>
                <button
                  class="icon-button danger"
                  title="删除供应商"
                  :disabled="config.providers.length === 1"
                  @click="config.providers.splice(providerIndex, 1)"
                >
                  <n-icon :component="TrashOutline" />
                </button>
              </div>
              <div class="provider-fields">
                <label
                  ><span>API 地址</span
                  ><input v-model="provider.options.base_url" placeholder="https://api.example.com/v1"
                /></label>
                <label
                  ><span>API Key</span>
                  <div class="secret-input">
                    <input
                      v-model="provider.options.api_key"
                      :type="showKeys[providerIndex] ? 'text' : 'password'"
                      placeholder="sk-..."
                    /><button
                      :title="showKeys[providerIndex] ? '隐藏密钥' : '显示密钥'"
                      @click="showKeys[providerIndex] = !showKeys[providerIndex]"
                    >
                      <n-icon :component="showKeys[providerIndex] ? EyeOffOutline : EyeOutline" />
                    </button></div
                ></label>
              </div>
              <div class="models-table">
                <div class="models-toolbar">
                  <strong>模型列表</strong>
                  <button :disabled="loadingProviders[providerIndex]" @click="fetchProviderModels(providerIndex)">
                    <n-icon :component="RefreshOutline" />
                    {{ loadingProviders[providerIndex] ? "正在获取" : "自动获取模型" }}
                  </button>
                </div>
                <p v-if="providerErrors[providerIndex]" class="provider-error" role="status">
                  {{ providerErrors[providerIndex] }}
                </p>
                <p v-else-if="providerModelOptions[providerIndex]?.length" class="provider-model-hint" role="status">
                  已获取 {{ providerModelOptions[providerIndex].length }} 个模型，可在模型 ID 输入框中选择
                </p>
                <div class="table-head"><span>真实模型 ID</span><span>配置中使用的别名</span><span></span></div>
                <div v-for="(model, modelIndex) in provider.models" :key="modelIndex" class="table-row">
                  <n-select
                    v-model:value="model.id"
                    class="model-id-select"
                    filterable
                    tag
                    size="small"
                    :options="getProviderModelOptions(providerIndex, model.id)"
                    placeholder="输入或选择模型 ID"
                  />
                  <input v-model="model.alias" placeholder="例如 deepseek-v4" />
                  <button
                    class="icon-button"
                    title="删除模型"
                    :disabled="provider.models.length === 1"
                    @click="provider.models.splice(modelIndex, 1)"
                  >
                    <n-icon :component="TrashOutline" />
                  </button>
                </div>
                <button class="text-button" @click="provider.models.push({ id: '', alias: '' })">
                  <n-icon :component="AddOutline" /> 添加一个模型
                </button>
              </div>
            </article>
          </section>
        </div>

        <aside class="status-column">
          <div class="status-card sticky">
            <div class="status-title">
              <span><n-icon :component="PulseOutline" /></span>
              <div><strong>配置健康度</strong><small>保存前快速检查</small></div>
            </div>
            <div class="score">
              <strong>{{ completion }}</strong
              ><span>%</span>
              <div class="score-track"><i :style="{ width: `${completion}%` }"></i></div>
            </div>
            <ul class="check-list">
              <li :class="{ done: config.napcat.qq_id }">
                <n-icon :component="config.napcat.qq_id ? CheckmarkCircle : HelpCircleOutline" /><span
                  ><strong>机器人账号</strong
                  ><small>{{ config.napcat.qq_id ? "QQ 号已填写" : "等待填写 QQ 号" }}</small></span
                >
              </li>
              <li :class="{ done: configuredKeys === config.providers.length }">
                <n-icon
                  :component="configuredKeys === config.providers.length ? CheckmarkCircle : HelpCircleOutline"
                /><span
                  ><strong>API 密钥</strong
                  ><small>{{ configuredKeys }}/{{ config.providers.length }} 个供应商已配置</small></span
                >
              </li>
              <li class="done">
                <n-icon :component="CheckmarkCircle" /><span
                  ><strong>模型分工</strong><small>{{ modelOptions.length }} 个模型可用</small></span
                >
              </li>
            </ul>
            <div class="restart-note">
              <n-icon :component="SettingsOutline" />
              <p><strong>保存后需要重启</strong><br />配置会写入 config.toml，重启 mita core 后生效。</p>
            </div>
          </div>
        </aside>
      </div>
    </main>
  </div>
</template>
