import { theme as antdTheme } from "ant-design-vue";
import type { ThemeConfig } from "ant-design-vue/es/config-provider/context";

/**
 * Ant Design Vue 深色主题映射。
 *
 * `apps/web/src/styles/tokens.css` 是设计令牌唯一来源；本文件只镜像 AntD
 * 需要参与色彩推导的少量基础色（AntD 算法无法接受 CSS 变量作为主色）。
 * 新增语义色时先改 tokens.css，再同步这里，避免两套视觉口径。
 */
export const VF_THEME: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: "#7B6CFF",
    colorInfo: "#56B3F5",
    colorSuccess: "#3DD68C",
    colorWarning: "#F5B14C",
    colorError: "#F26D6D",
    colorBgBase: "#0B0E13",
    colorBgLayout: "#0B0E13",
    colorBgContainer: "#141821",
    colorBgElevated: "#1B2130",
    colorBorder: "#262E3D",
    colorBorderSecondary: "#1D2430",
    colorText: "#EDF1F7",
    colorTextSecondary: "#97A3B4",
    colorTextTertiary: "#626D7E",
    colorTextQuaternary: "#626D7E",
    borderRadius: 8,
    borderRadiusLG: 12,
    fontSize: 13,
    lineHeight: 1.5,
    fontFamily:
      'PingFang SC, "Microsoft YaHei", system-ui, -apple-system, sans-serif',
    controlHeight: 36,
  },
  components: {
    Button: {
      fontWeight: 600,
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
    },
    Card: {
      borderRadiusLG: 12,
      paddingLG: 20,
      colorBgContainer: "#141821",
    },
    Modal: {
      borderRadiusLG: 12,
      colorBgElevated: "#141821",
      contentBg: "#141821",
      headerBg: "#141821",
    },
    Input: {
      controlHeight: 40,
      colorBgContainer: "#141821",
      activeBorderColor: "#7B6CFF",
      hoverBorderColor: "#262E3D",
    },
    Select: {
      controlHeight: 40,
      colorBgContainer: "#141821",
      optionSelectedBg: "#232041",
    },
    Table: {
      headerBg: "#1B2130",
      headerColor: "#626D7E",
      rowHoverBg: "#1B2130",
      borderColor: "#1D2430",
    },
    Menu: {
      darkItemBg: "#07090D",
      darkItemSelectedBg: "#1B2130",
      darkItemHoverBg: "#141821",
      darkItemColor: "#97A3B4",
      darkItemSelectedColor: "#EDF1F7",
      itemBorderRadius: 8,
    },
    Tooltip: {
      colorBgSpotlight: "#1B2130",
      colorTextLightSolid: "#EDF1F7",
    },
  },
};
