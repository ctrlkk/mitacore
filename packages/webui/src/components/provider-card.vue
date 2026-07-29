<script setup lang="ts">
import { computed } from "vue";
import {
  AddOutline,
  AlertCircleOutline,
  CheckmarkCircleOutline,
  RefreshOutline,
  TrashOutline,
} from "@vicons/ionicons5";
import { NButton, NCard, NForm, NFormItem, NIcon, NInput, NSelect, NSpace, NTag, NTooltip } from "naive-ui";
import type { ProviderDraft, ProviderModel, ProviderType } from "../api";

const props = defineProps<{
  provider: ProviderDraft;
  availableModels: string[];
}>();

const emit = defineEmits<{
  connectionChange: [changes: Partial<Pick<ProviderDraft, "type" | "base_url" | "api_key">>];
  modelsChange: [models: ProviderModel[]];
  loadModels: [];
  remove: [];
}>();

const typeOptions: Array<{ label: string; value: ProviderType }> = [
  { label: "Anthropic", value: "anthropic" },
  { label: "DeepSeek", value: "deepseek" },
  { label: "OpenAI", value: "openai" },
  { label: "OpenAI-compatible", value: "openai-compatible" },
];

const modelOptions = computed(() => props.availableModels.map((id) => ({ label: id, value: id })));
const isLoading = computed(() => props.provider.models_status === "loading");
const status = computed(() => {
  if (props.provider.models_status === "loading") return { type: "info" as const, label: "正在加载模型" };
  if (props.provider.models_status === "stale") return { type: "warning" as const, label: "连接已修改，请重新加载" };
  if (props.provider.models_status === "error") return { type: "error" as const, label: "加载失败，请重试" };
  if (props.provider.models_status === "ready")
    return { type: "success" as const, label: `已配置 ${props.provider.models.length} 个模型` };
  return { type: "default" as const, label: "尚未加载模型" };
});
</script>

<template>
  <NCard size="large" class="provider-card">
    <template #header>
      <NSpace align="center" :size="10">
        <span>{{ typeOptions.find((option) => option.value === provider.type)?.label }}</span>
        <NTag :type="status.type" size="small" :bordered="false">{{ status.label }}</NTag>
      </NSpace>
    </template>
    <template #header-extra>
      <NTooltip>
        <template #trigger>
          <NButton quaternary circle type="error" aria-label="删除供应商" @click="emit('remove')">
            <template #icon
              ><NIcon><TrashOutline /></NIcon
            ></template>
          </NButton>
        </template>
        删除供应商
      </NTooltip>
    </template>

    <NForm label-placement="top" class="provider-form">
      <div class="provider-fields">
        <NFormItem label="供应商类型">
          <NSelect
            :value="provider.type"
            :options="typeOptions"
            @update:value="(type) => emit('connectionChange', { type })"
          />
        </NFormItem>
        <NFormItem label="Base URL">
          <NInput
            :value="provider.base_url"
            placeholder="https://api.example.com/v1"
            @update:value="(base_url) => emit('connectionChange', { base_url })"
          />
        </NFormItem>
        <NFormItem label="API Key">
          <NInput
            :value="provider.api_key"
            type="password"
            show-password-on="click"
            placeholder="已设置；留空时保持不变"
            @update:value="(api_key) => emit('connectionChange', { api_key })"
          />
        </NFormItem>
      </div>
    </NForm>

    <div class="model-toolbar">
      <div>
        <strong>可用模型</strong>
        <p>从 AI SDK 提供的模型目录中选择，并为运行时创建稳定别名。</p>
      </div>
      <NButton type="primary" secondary :loading="isLoading" @click="emit('loadModels')">
        <template #icon
          ><NIcon><RefreshOutline /></NIcon
        ></template>
        加载模型
      </NButton>
    </div>

    <div v-if="provider.models_status === 'error'" class="model-load-error">
      <NIcon size="18"><AlertCircleOutline /></NIcon>
      无法加载模型，请检查连接配置后重试。
    </div>

    <div v-if="provider.models.length > 0" class="model-list" role="list" aria-label="已添加模型">
      <div class="model-list-header" aria-hidden="true">
        <span>模型 ID</span>
        <span>别名</span>
        <span></span>
      </div>
      <div v-for="(model, index) in provider.models" :key="`${model.id}-${index}`" class="model-row" role="listitem">
        <NSelect
          :value="model.id"
          :options="modelOptions"
          filterable
          placeholder="先加载模型列表"
          @update:value="
            (id) =>
              emit(
                'modelsChange',
                provider.models.map((item, itemIndex) => (itemIndex === index ? { ...item, id } : item)),
              )
          "
        />
        <NInput
          :value="model.alias"
          placeholder="例如 deepseek-v4-pro"
          @update:value="
            (alias) =>
              emit(
                'modelsChange',
                provider.models.map((item, itemIndex) => (itemIndex === index ? { ...item, alias } : item)),
              )
          "
        />
        <NTooltip>
          <template #trigger>
            <NButton
              quaternary
              circle
              type="error"
              aria-label="删除模型"
              @click="
                emit(
                  'modelsChange',
                  provider.models.filter((_, itemIndex) => itemIndex !== index),
                )
              "
            >
              <template #icon
                ><NIcon><TrashOutline /></NIcon
              ></template>
            </NButton>
          </template>
          删除模型
        </NTooltip>
      </div>
    </div>
    <div v-else class="empty-models">
      <NIcon size="18"><CheckmarkCircleOutline /></NIcon>
      加载模型后，在这里选择需要使用的模型。
    </div>

    <NButton
      text
      type="primary"
      :disabled="availableModels.length === 0"
      @click="
        emit('modelsChange', [...provider.models, { id: availableModels[0] ?? '', alias: availableModels[0] ?? '' }])
      "
    >
      <template #icon
        ><NIcon><AddOutline /></NIcon
      ></template>
      添加模型
    </NButton>
  </NCard>
</template>
