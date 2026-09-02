import type { AeroResult, CarSpec } from '../types'

type ComparisonPanelProps = {
  activeCar: CarSpec
  baselineCar: CarSpec
  active: AeroResult
  baseline: AeroResult
}

const formatForce = (value: number) => `${Math.round(value).toLocaleString('zh-CN')} N`
const formatSignedForce = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value)).toLocaleString('zh-CN')} N`
const formatSigned = (value: number, digits = 2) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`

export const ComparisonPanel = ({ activeCar, baselineCar, active, baseline }: ComparisonPanelProps) => {
  const rows = [
    { id: 'downforce', label: '总下压力', active: formatForce(active.downforceN), delta: formatSignedForce(active.downforceN - baseline.downforceN), tone: active.downforceN >= baseline.downforceN ? 'positive' : 'negative' },
    { id: 'drag', label: '总阻力', active: formatForce(active.totalDragN), delta: formatSignedForce(active.totalDragN - baseline.totalDragN), tone: active.totalDragN <= baseline.totalDragN ? 'positive' : 'negative' },
    { id: 'efficiency', label: '气动效率', active: `${active.downforceToDrag.toFixed(2)} : 1`, delta: `${formatSigned(active.downforceToDrag - baseline.downforceToDrag, 2)} : 1`, tone: active.downforceToDrag >= baseline.downforceToDrag ? 'positive' : 'negative' },
    { id: 'vertical-load', label: '垂向总载荷', active: formatForce(active.totalVerticalLoadN), delta: formatSignedForce(active.totalVerticalLoadN - baseline.totalVerticalLoadN), tone: active.totalVerticalLoadN >= baseline.totalVerticalLoadN ? 'positive' : 'negative' },
  ]

  return (
    <section className="comparison-panel" aria-labelledby="comparison-title">
      <div className="comparison-panel__header">
        <div>
          <div className="eyebrow">差值视图 / 同工况对比</div>
          <h2 id="comparison-title">赛车概念对比</h2>
        </div>
        <span className="comparison-chip">仅供相对比较</span>
      </div>
      <div className="comparison-table" role="table" aria-label="当前赛车与基准赛车对比">
        <div className="comparison-row comparison-row--head" role="row">
          <span role="columnheader">指标</span>
          <span role="columnheader" style={{ color: activeCar.accent }}>{activeCar.code} / 当前</span>
          <span role="columnheader" style={{ color: baselineCar.accent }}>{baselineCar.code} / 基准</span>
          <span role="columnheader">差值</span>
        </div>
        {rows.map((row) => {
          const baselineValue = row.id === 'downforce'
            ? formatForce(baseline.downforceN)
            : row.id === 'drag'
              ? formatForce(baseline.totalDragN)
              : row.id === 'efficiency'
                ? `${baseline.downforceToDrag.toFixed(2)} : 1`
                : formatForce(baseline.totalVerticalLoadN)
          return (
            <div className="comparison-row" role="row" key={row.id}>
              <span role="cell">{row.label}</span>
              <b role="cell">{row.active}</b>
              <span role="cell">{baselineValue}</span>
              <strong className={`delta delta--${row.tone}`} role="cell">{row.delta}</strong>
            </div>
          )
        })}
      </div>
      <p className="comparison-footnote">
        风速、车库设置与底板设计保持一致；当前车与基准车分别采用各自整备质量，用于比较完整赛车概念趋势。
      </p>
    </section>
  )
}
