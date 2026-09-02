# AeroLab F1 风洞趋势模拟器

面向现代 F1 赛车空气动力学学习与方案对比的中文交互式工作台。页面使用 Three.js 展示规则年代匹配的高精度参考模型，并用网格采样烟流、示踪路径和调整前后差值热色，直观呈现翼面设定变化。

## 当前能力

- 2026 主动空气动力学与 2022–2025 DRS 两套规则状态。
- 规则年代对应的 RB22、VF-26、SF23 与 AMR23 参考模型。
- 参数化分析模型与授权参考模型双模式。
- 已验证的前翼主翼、前翼襟翼、尾翼主翼和尾翼襟翼独立姿态。
- 基准风场、当前风场和黄色→橙色→洋红色局部差值显示。
- 实际采样路径偏移读数；热色显示允许放大 ×3，但读数不放大。
- 速度驱动烟流密度、推进速度和动压，不伪造路径偏转。
- 1280×720 桌面端一屏工作台，以及移动端响应式布局。

## 模拟边界

这是**相对趋势模拟器，不是 CFD 求解器**。浏览器中的烟流由参考模型表面射线采样生成，适合观察设置方向、局部影响区域和指标权衡，不能替代风洞标定或 Navier–Stokes 数值求解。

参考模型只开放已经验证的真实语义节点。当前 RB22 参考模型允许调整前后翼；车高、底板和扩散器在参考模型下禁用，切换到分析模型后才开放趋势调节。工程 CFD 的几何、网格、求解与验收链路见 [`cfd/README.md`](cfd/README.md)。

## 本地运行

要求 Node.js 20+ 与 pnpm 10+。

```bash
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1 --port 5173
```

打开 <http://127.0.0.1:5173/>。建议使用支持 WebGL 2 的最新版 Chrome、Edge 或 Firefox。

## 验证与构建

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm preview
```

当前自动测试覆盖空气动力趋势公式、规则车型、部件独立姿态、参考模型节点识别、风场稳定采样、差值热色、速度语义和模型切换。

## GitHub Pages

项目内置 `.github/workflows/pages.yml`。推送到 `main` 后，在仓库 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**，工作流会按仓库名设置 Vite 基础路径并部署 `dist`。

## 模型许可

`public/models` 中优化后的模型依据 **CC BY 4.0** 分发。作者、原始地址、衍生说明和许可链接见 [`public/models/ATTRIBUTION.md`](public/models/ATTRIBUTION.md)，页面中也保留了可点击署名。
