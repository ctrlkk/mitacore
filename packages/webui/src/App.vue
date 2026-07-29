<script setup lang="ts">
import { computed, ref } from "vue";
import { AddOutline, HardwareChipOutline, SaveOutline } from "@vicons/ionicons5";
import {
  NButton,
  NCard,
  NConfigProvider,
  NDivider,
  NEmpty,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NSpace,
  NText,
  useMessage,
} from "naive-ui";
import ModelRoleForm from "./components/model-role-form.vue";
import ProviderCard from "./components/provider-card.vue";
import {
  getModelAliases,
  removeModel,
  updateProviderConnection,
  type ModelConfigDraft,
  type ProviderDraft,
  type ProviderModel,
  type ProviderType,
} from "./model-config";
import { initialDraft, loadModels } from "./mocks/config";

const message = useMessage();
const initial = structuredClone(initialDraft);
const draft = ref<ModelConfigDraft>(structuredClone(initial));
const availableModels = ref<Record<string, string[]>>({
  "provider-deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "provider-mimo": ["mimo-v2.5", "mimo-v2.5-thinking"],
});

const aliases = computed(() => getModelAliases(draft.value));
const isDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(initial));

function replaceProvider(id: string, update: (provider: ProviderDraft) => ProviderDraft) {
  draft.value = {
    ...draft.value,
    providers: draft.value.providers.map((provider) => (provider.id === id ? update(provider) : provider)),
  };
}

function onConnectionChange(id: string, changes: Partial<Pick<ProviderDraft, "type" | "base_url" | "api_key">>) {
  draft.value = updateProviderConnection(draft.value, id, changes);
}

async function onLoadModels(id: string) {
  const provider = draft.value.providers.find((item) => item.id === id);
  if (!provider) return;
  replaceProvider(id, (item) => ({ ...item, models_status: "loading" }));
  try {
    const models = await loadModels(provider.type);
    availableModels.value = { ...availableModels.value, [id]: models };
    replaceProvider(id, (item) => ({ ...item, models_status: "ready" }));
    message.success(`已加载 ${models.length} 个模型`);
  } catch {
    replaceProvider(id, (item) => ({ ...item, models_status: "error" }));
    message.error("模型加载失败，请检查供应商配置后重试");
  }
}

function onModelsChange(id: string, models: ProviderModel[]) {
  const previous = draft.value.providers.find((provider) => provider.id === id)?.models ?? [];
  const removedIndex = previous.findIndex(
    (model, index) => !models[index] || models[index]?.id !== model.id || models[index]?.alias !== model.alias,
  );
  if (models.length < previous.length && removedIndex >= 0) {
    draft.value = removeModel(draft.value, id, removedIndex);
    return;
  }
  replaceProvider(id, (provider) => ({ ...provider, models }));
}

function addProvider() {
  const id = `provider-${crypto.randomUUID()}`;
  draft.value = {
    ...draft.value,
    providers: [
      ...draft.value.providers,
      { id, type: "openai-compatible", base_url: "", api_key: "", models_status: "idle", models: [] },
    ],
  };
}

function removeProvider(id: string) {
  const aliasesToRemove = new Set(
    draft.value.providers.find((provider) => provider.id === id)?.models.map((model) => model.alias) ?? [],
  );
  draft.value = {
    providers: draft.value.providers.filter((provider) => provider.id !== id),
    roles: Object.fromEntries(
      Object.entries(draft.value.roles).map(([key, alias]) => [key, aliasesToRemove.has(alias) ? "" : alias]),
    ) as ModelConfigDraft["roles"],
  };
}

function resetDraft() {
  draft.value = structuredClone(initial);
  message.info("已还原为当前保存的配置");
}

function onRolesUpdate(roles: ModelConfigDraft["roles"]) {
  draft.value = { ...draft.value, roles };
}

function saveDraft() {
  message.success("页面草稿已准备好，接入 Hono 后将保存到 config.toml");
}
</script>

<template>
  <NConfigProvider>
    <NLayout class="app-shell">
      <NLayoutHeader bordered class="app-header">
        <div class="header-content">
          <NSpace align="center" :size="12">
            <div class="brand-mark">
              <NIcon size="22"><HardwareChipOutline /></NIcon>
            </div>
            <div>
              <p class="eyebrow">MITA CORE</p>
              <h1>模型配置</h1>
            </div>
          </NSpace>
          <NSpace align="center">
            <NText :type="isDirty ? 'warning' : 'success'">{{ isDirty ? "草稿未保存" : "配置已同步" }}</NText>
            <NButton type="primary" @click="saveDraft">
              <template #icon
                ><NIcon><SaveOutline /></NIcon
              ></template>
              保存配置
            </NButton>
          </NSpace>
        </div>
      </NLayoutHeader>

      <NLayoutContent content-style="padding: 40px 24px 72px">
        <main class="page-content">
          <section class="intro" aria-labelledby="page-description">
            <div>
              <p class="section-kicker">第一步</p>
              <h2 id="page-description">配置供应商与模型</h2>
              <p>加载供应商可用模型，为模型建立别名，再分配给机器人各项职责。</p>
            </div>
            <NCard size="small" class="restart-note" :bordered="false"> 保存后将在重启机器人时生效 </NCard>
          </section>

          <div class="config-grid">
            <section class="providers-section" aria-labelledby="providers-title">
              <div class="section-heading">
                <div>
                  <p class="section-kicker">供应商</p>
                  <h2 id="providers-title">模型供应商</h2>
                </div>
                <NButton type="primary" secondary @click="addProvider">
                  <template #icon
                    ><NIcon><AddOutline /></NIcon
                  ></template>
                  添加供应商
                </NButton>
              </div>

              <div v-if="draft.providers.length > 0" class="provider-stack">
                <ProviderCard
                  v-for="provider in draft.providers"
                  :key="provider.id"
                  :provider="provider"
                  :available-models="availableModels[provider.id] ?? []"
                  @connection-change="(changes) => onConnectionChange(provider.id, changes)"
                  @models-change="(models) => onModelsChange(provider.id, models)"
                  @load-models="onLoadModels(provider.id)"
                  @remove="removeProvider(provider.id)"
                />
              </div>
              <NEmpty v-else description="还没有模型供应商">
                <template #extra><NButton type="primary" @click="addProvider">添加第一个供应商</NButton></template>
              </NEmpty>
            </section>

            <aside class="roles-section">
              <ModelRoleForm :aliases="aliases" :roles="draft.roles" @update="onRolesUpdate" />
            </aside>
          </div>

          <NDivider />
          <footer class="page-actions">
            <NText depth="3">模型列表目前使用页面 mock；下一阶段会替换成 Hono + AI SDK 数据源。</NText>
            <NSpace>
              <NButton :disabled="!isDirty" @click="resetDraft">还原未保存修改</NButton>
              <NButton type="primary" @click="saveDraft">保存配置</NButton>
            </NSpace>
          </footer>
        </main>
      </NLayoutContent>
    </NLayout>
  </NConfigProvider>
</template>
