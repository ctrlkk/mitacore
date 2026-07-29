import { createApp, h } from "vue";
import {
  create,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NConfigProvider,
  NDivider,
  NDynamicInput,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NMessageProvider,
  NSelect,
  NSpace,
  NTag,
  NTooltip,
} from "naive-ui";
import App from "./App.vue";
import "./style.css";

const naive = create({
  components: [
    NButton,
    NCard,
    NCollapse,
    NCollapseItem,
    NConfigProvider,
    NDivider,
    NDynamicInput,
    NEmpty,
    NForm,
    NFormItem,
    NIcon,
    NInput,
    NLayout,
    NLayoutContent,
    NLayoutHeader,
    NMessageProvider,
    NSelect,
    NSpace,
    NTag,
    NTooltip,
  ],
});

createApp({
  render: () => h(NMessageProvider, null, { default: () => h(App) }),
})
  .use(naive)
  .mount("#app");
