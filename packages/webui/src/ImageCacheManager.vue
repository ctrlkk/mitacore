<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { NIcon } from "naive-ui";
import {
  AlertCircleOutline,
  CheckmarkCircleOutline,
  CloseOutline,
  ImageOutline,
  PencilOutline,
  RefreshOutline,
  SearchOutline,
  TrashOutline,
} from "@vicons/ionicons5";

type CachedImage = {
  filename: string;
  path: string;
  description: string;
  size: number;
  updated_at: number;
  url: string;
};

type SortMode = "newest" | "oldest" | "largest" | "smallest";

const images = ref<CachedImage[]>([]);
const loading = ref(true);
const loadError = ref("");
const search = ref("");
const sortMode = ref<SortMode>("newest");
const page = ref(1);
const pageSize = ref(24);
const paginationTotal = ref(0);
const totalPages = ref(1);
const summaryTotal = ref(0);
const summarySize = ref(0);
const selected = ref<CachedImage>();
const descriptionDraft = ref("");
const saving = ref(false);
const deleting = ref(false);
const confirmDelete = ref(false);
const actionError = ref("");
const saved = ref(false);
let searchTimer: number | undefined;
let loadController: AbortController | undefined;

const pageNumbers = computed(() => {
  const start = Math.max(1, page.value - 2);
  const end = Math.min(totalPages.value, page.value + 2);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
});

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

async function loadImages() {
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  loadError.value = "";
  try {
    const query = new URLSearchParams({
      page: String(page.value),
      page_size: String(pageSize.value),
      search: search.value.trim(),
      sort: sortMode.value,
    });
    const response = await fetch(`/api/images?${query}`, { signal: controller.signal });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.error?.message ?? "加载图片缓存失败");
    images.value = Array.isArray(payload?.images) ? payload.images : [];
    page.value = typeof payload?.pagination?.page === "number" ? payload.pagination.page : 1;
    paginationTotal.value = typeof payload?.pagination?.total === "number" ? payload.pagination.total : 0;
    totalPages.value = typeof payload?.pagination?.total_pages === "number" ? payload.pagination.total_pages : 1;
    summaryTotal.value = typeof payload?.summary?.total === "number" ? payload.summary.total : images.value.length;
    summarySize.value = typeof payload?.summary?.total_size === "number" ? payload.summary.total_size : 0;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    loadError.value = error instanceof Error ? error.message : "加载图片缓存失败";
  } finally {
    if (loadController === controller) loading.value = false;
  }
}

function goToPage(targetPage: number) {
  if (targetPage === page.value || targetPage < 1 || targetPage > totalPages.value) return;
  page.value = targetPage;
  loadImages();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openImage(image: CachedImage) {
  selected.value = image;
  descriptionDraft.value = image.description;
  actionError.value = "";
  confirmDelete.value = false;
  saved.value = false;
}

function closeImage() {
  if (saving.value || deleting.value) return;
  selected.value = undefined;
}

async function saveDescription() {
  if (!selected.value) return;
  saving.value = true;
  actionError.value = "";
  saved.value = false;
  try {
    const response = await fetch(`/api/images/${encodeURIComponent(selected.value.filename)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: descriptionDraft.value }),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.error?.message ?? "保存图片描述失败");
    selected.value.description = payload.description;
    saved.value = true;
    window.setTimeout(() => (saved.value = false), 2000);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "保存图片描述失败";
  } finally {
    saving.value = false;
  }
}

async function deleteImage() {
  if (!selected.value) return;
  deleting.value = true;
  actionError.value = "";
  try {
    const response = await fetch(`/api/images/${encodeURIComponent(selected.value.filename)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.error?.message ?? "删除图片失败");
    selected.value = undefined;
    await loadImages();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "删除图片失败";
  } finally {
    deleting.value = false;
  }
}

watch(sortMode, () => {
  page.value = 1;
  loadImages();
});

watch(pageSize, () => {
  page.value = 1;
  loadImages();
});

watch(search, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    page.value = 1;
    loadImages();
  }, 300);
});

onMounted(loadImages);
onUnmounted(() => {
  window.clearTimeout(searchTimer);
  loadController?.abort();
});
</script>

<template>
  <div class="image-cache-page">
    <section class="cache-summary">
      <div>
        <p class="eyebrow">IMAGE LIBRARY</p>
        <h2>图片缓存</h2>
        <p>集中预览机器人已缓存的图片，并维护用于模型理解的图片描述。</p>
      </div>
      <div class="cache-metrics">
        <span
          ><strong>{{ summaryTotal }}</strong> 张图片</span
        >
        <span
          ><strong>{{ formatSize(summarySize) }}</strong> 占用空间</span
        >
      </div>
    </section>

    <section class="cache-toolbar" aria-label="图片筛选工具">
      <label class="cache-search">
        <n-icon :component="SearchOutline" />
        <input v-model="search" placeholder="搜索文件名或图片描述" />
        <button v-if="search" aria-label="清空搜索" @click="search = ''"><n-icon :component="CloseOutline" /></button>
      </label>
      <select v-model="sortMode" aria-label="图片排序">
        <option value="newest">最近更新</option>
        <option value="oldest">最早更新</option>
        <option value="largest">体积最大</option>
        <option value="smallest">体积最小</option>
      </select>
      <button class="cache-refresh" :disabled="loading" @click="loadImages">
        <n-icon :component="RefreshOutline" />{{ loading ? "正在刷新" : "刷新" }}
      </button>
    </section>

    <div v-if="loadError" class="cache-state error" role="alert">
      <n-icon :component="AlertCircleOutline" />
      <div>
        <strong>暂时无法读取缓存</strong><span>{{ loadError }}</span>
      </div>
      <button @click="loadImages">重试</button>
    </div>
    <div v-else-if="loading" class="cache-state"><span class="cache-spinner"></span>正在读取图片缓存…</div>
    <div v-else-if="!images.length" class="cache-empty">
      <span><n-icon :component="ImageOutline" /></span>
      <h3>{{ summaryTotal ? "没有匹配的图片" : "还没有图片缓存" }}</h3>
      <p>{{ summaryTotal ? "换一个关键词试试。" : "机器人收到或生成图片后，会自动显示在这里。" }}</p>
    </div>
    <section v-else class="image-grid" aria-live="polite">
      <button v-for="image in images" :key="image.filename" class="image-card" @click="openImage(image)">
        <span class="image-card-preview"
          ><img :src="image.url" :alt="image.description || image.filename" loading="lazy"
        /></span>
        <span class="image-card-copy">
          <strong :title="image.filename">{{ image.filename }}</strong>
          <small>{{ formatSize(image.size) }} · {{ formatDate(image.updated_at) }}</small>
          <em :class="{ empty: !image.description }">{{ image.description || "暂无图片描述" }}</em>
        </span>
      </button>
    </section>

    <nav v-if="!loading && !loadError && paginationTotal > 0" class="cache-pagination" aria-label="图片分页">
      <span>共 {{ paginationTotal }} 条，第 {{ page }} / {{ totalPages }} 页</span>
      <div class="pagination-buttons">
        <button :disabled="page === 1" @click="goToPage(page - 1)">上一页</button>
        <button v-if="pageNumbers[0] !== 1" @click="goToPage(1)">1</button>
        <em v-if="pageNumbers[0] && pageNumbers[0] > 2">…</em>
        <button
          v-for="pageNumber in pageNumbers"
          :key="pageNumber"
          :class="{ active: pageNumber === page }"
          :aria-current="pageNumber === page ? 'page' : undefined"
          @click="goToPage(pageNumber)"
        >
          {{ pageNumber }}
        </button>
        <em v-if="pageNumbers.at(-1) && pageNumbers.at(-1)! < totalPages - 1">…</em>
        <button v-if="pageNumbers.at(-1) !== totalPages" @click="goToPage(totalPages)">{{ totalPages }}</button>
        <button :disabled="page === totalPages" @click="goToPage(page + 1)">下一页</button>
      </div>
      <label
        >每页
        <select v-model.number="pageSize">
          <option :value="12">12</option>
          <option :value="24">24</option>
          <option :value="48">48</option>
          <option :value="96">96</option>
        </select>
        条</label
      >
    </nav>

    <div v-if="selected" class="image-dialog-backdrop" @click.self="closeImage">
      <section class="image-dialog" role="dialog" aria-modal="true" aria-label="图片详情">
        <button class="dialog-close" aria-label="关闭" @click="closeImage"><n-icon :component="CloseOutline" /></button>
        <div class="dialog-preview"><img :src="selected.url" :alt="selected.description || selected.filename" /></div>
        <div class="dialog-details">
          <div class="dialog-heading">
            <p class="eyebrow">IMAGE DETAILS</p>
            <h2>{{ selected.filename }}</h2>
            <span>{{ formatSize(selected.size) }} · 更新于 {{ formatDate(selected.updated_at) }}</span>
          </div>
          <label class="description-editor">
            <span><n-icon :component="PencilOutline" /> 图片描述</span>
            <textarea
              v-model="descriptionDraft"
              maxlength="10000"
              placeholder="记录图片内容、含义或适用场景"
            ></textarea>
            <small>{{ descriptionDraft.length }} / 10000</small>
          </label>
          <p class="description-help">这段描述会作为缓存供模型理解图片；修改不会改变图片文件。</p>
          <div v-if="actionError" class="dialog-error" role="alert">{{ actionError }}</div>
          <div v-if="confirmDelete" class="delete-confirm">
            <span>删除后无法从管理页恢复，确定继续吗？</span>
            <button @click="confirmDelete = false">取消</button>
            <button class="danger" :disabled="deleting" @click="deleteImage">
              {{ deleting ? "正在删除" : "确认删除" }}
            </button>
          </div>
          <div v-else class="dialog-actions">
            <button class="delete-button" @click="confirmDelete = true">
              <n-icon :component="TrashOutline" />删除图片
            </button>
            <button class="save-description" :disabled="saving" @click="saveDescription">
              <n-icon :component="saved ? CheckmarkCircleOutline : PencilOutline" />
              {{ saving ? "正在保存" : saved ? "已保存" : "保存描述" }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
