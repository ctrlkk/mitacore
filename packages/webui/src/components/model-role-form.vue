<script setup lang="ts">
import { computed } from "vue";
import { NCard, NForm, NFormItem, NSelect, NText } from "naive-ui";
import type { ModelRoles } from "../api";

const props = defineProps<{
  aliases: string[];
  roles: ModelRoles;
}>();

const emit = defineEmits<{
  update: [roles: ModelRoles];
}>();

const options = computed(() => [
  { label: "未启用", value: "" },
  ...props.aliases.map((alias) => ({ label: alias, value: alias })),
]);

const fields: Array<{ key: keyof ModelRoles; label: string; hint: string }> = [
  { key: "plan", label: "规划模型", hint: "用于分析对话并规划回复" },
  { key: "reply", label: "回复模型", hint: "用于生成面向用户的回复" },
  { key: "main", label: "主 Agent 模型", hint: "启用 Agent 模式时使用" },
  { key: "multimodal_image", label: "图像理解模型", hint: "处理图片消息" },
  { key: "multimodal_video", label: "视频理解模型", hint: "处理视频消息" },
  { key: "multimodal_audio", label: "音频理解模型", hint: "处理音频消息" },
];
</script>

<template>
  <NCard title="模型职责" size="large" class="role-card">
    <template #header-extra>
      <NText depth="3">从已配置的模型别名中选择</NText>
    </template>
    <NForm label-placement="top" class="role-form">
      <NFormItem v-for="field in fields" :key="field.key" :label="field.label">
        <NSelect
          :value="roles[field.key]"
          :options="options"
          filterable
          :placeholder="aliases.length === 0 ? '请先添加模型' : '请选择模型'"
          :disabled="aliases.length === 0"
          @update:value="(value) => emit('update', { ...roles, [field.key]: value })"
        />
        <template #feedback>{{ field.hint }}</template>
      </NFormItem>
    </NForm>
  </NCard>
</template>
