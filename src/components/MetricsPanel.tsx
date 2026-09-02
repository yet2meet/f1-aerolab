import type { AeroResult, CarSpec } from '../types'

type MetricsPanelProps = {
  car: CarSpec
  result: AeroResult
}

const force = (value: number) => `${Math.round(value).toLocaleString('zh-CN')} N`
const number = (value: number, digits = 2) => value.toFixed(digits)

export const MetricsPanel = ({ car, result }: MetricsPanelProps) => (
  <section className="metrics-panel" aria-labelledby="metrics-title">
    <div className="section-heading section-heading--inline">
      <div>
        <div className="eyebrow">实时遥测 / {car.code}</div>
        <h2 id="metrics-title">空气动力载荷图</h2>
      </div>
      <span className="metric-status"><i /> 已计算</span>
    </div>

    <div className="metric-grid">
      <article className="metric-card metric-card--primary">
        <div className="metric-label">总下压力 <span>Fz−</span></div>
        <strong>{force(result.downforceN)}</strong>
        <div className="metric-meta">CL {number(result.effectiveCl)} · 气动效率 {number(result.downforceToDrag, 1)} : 1</div>
      </article>
      <article className="metric-card metric-card--drag">
        <div className="metric-label">总阻力 <span>Fx+</span></div>
        <strong>{force(result.totalDragN)}</strong>
        <div className="metric-meta">气动 {force(result.aeroDragN)} · 滚阻 {force(result.rollingResistanceN)}</div>
      </article>
      <article className="metric-card">
        <div className="metric-label">静态重量 <span>Mg</span></div>
        <strong>{force(result.staticWeightN)}</strong>
        <div className="metric-meta">总垂向载荷 {force(result.totalVerticalLoadN)}</div>
      </article>
      <article className="metric-card">
        <div className="metric-label">动压 <span>q</span></div>
        <strong>{Math.round(result.dynamicPressurePa).toLocaleString('zh-CN')} <small>Pa</small></strong>
        <div className="metric-meta">{result.velocityMs.toFixed(1)} m/s · {result.tirePressurePsi.toFixed(1)} psi</div>
      </article>
    </div>

    <div className="load-split">
      <div className="load-split__header">
        <span>前后轴载荷分配</span>
        <strong>前轴 {number(result.frontBiasPercent, 1)}% / 后轴 {number(100 - result.frontBiasPercent, 1)}%</strong>
      </div>
      <div className="load-bar" role="img" aria-label={`下压力分配：前轴 ${number(result.frontBiasPercent, 1)}%，后轴 ${number(100 - result.frontBiasPercent, 1)}%`}>
        <span className="load-bar__front" style={{ width: `${result.frontBiasPercent}%` }} />
        <span className="load-bar__rear" />
      </div>
      <div className="load-split__values">
        <span><i className="dot dot--cyan" /> 前轴 <b>{force(result.frontDownforceN)}</b></span>
        <span><i className="dot dot--orange" /> 后轴 <b>{force(result.rearDownforceN)}</b></span>
      </div>
    </div>

    <div className="signal-grid">
      <div className="signal"><span>地面效应</span><b>{result.groundEffectFactor.toFixed(2)}×</b></div>
      <div className="signal"><span>底板载荷</span><b>{result.floorLoadFactor.toFixed(2)}×</b></div>
      <div className="signal"><span>平台稳定性</span><b>{Math.round(result.platformStabilityFactor * 100)}%</b></div>
      <div className="signal"><span>前后倾差</span><b>{result.rakeMm >= 0 ? '+' : ''}{result.rakeMm.toFixed(0)} mm</b></div>
      <div className="signal"><span>制动偏置</span><b>前轴 {result.brakeBiasFrontPercent.toFixed(1)}%</b></div>
      <div className="signal"><span>气动状态</span><b>{result.activeAeroMode === 'straight' ? '直道' : '弯道'}</b></div>
    </div>
  </section>
)
