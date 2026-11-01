import { createApp } from "vue";
import { createPinia } from "pinia";
import Antd from "ant-design-vue";
import "ant-design-vue/dist/reset.css";
import { router } from "./router";
import App from "./App.vue";
import "./styles/global.css";

const app = createApp(App);
app.use(createPinia()).use(router).use(Antd).mount("#app");
console.info("[web] VideoForge console mounted");
