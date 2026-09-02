import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { ComparisonPanel } from './components/ComparisonPanel'
import { Controls } from './components/Controls'
import { MetricsPanel } from './components/MetricsPanel'
import { WindTunnelView } from './components/WindTunnelView'
import { cars, carsForRuleset, defaultParams } from './data/cars'
import { calculateAero } from './lib/aero'
import type { AeroDesign, DriverControls, GarageSetup, Ruleset, RunConditions } from './types'
import './index.css'

const App = () => {
  const initialCar = carsForRuleset('2026')[0] ?? cars[0]
  const initialBaseline = cars.find((car) => car.ruleset === '2026' && car.id !== initialCar.id) ?? initialCar
  const [selectedCarId, setSelectedCarId] = useState(initialCar.id)
  const [baselineCarId, setBaselineCarId] = useState(initialBaseline.id)
  const [params, setParams] = useState(() => defaultParams(initialCar))
  const [referenceCapability, setReferenceCapability] = useState({
    referenceMode: false,
    wingAdjustable: false,
  })

  const availableCars = useMemo(() => carsForRuleset(params.ruleset), [params.ruleset])
  const selectedCar = availableCars.find((car) => car.id === selectedCarId) ?? availableCars[0] ?? initialCar
  const baselineCar = availableCars.find((car) => car.id === baselineCarId)
    ?? availableCars.find((car) => car.id !== selectedCar.id)
    ?? selectedCar
  const result = useMemo(() => calculateAero(selectedCar, params), [selectedCar, params])
  const baselineParams = useMemo(
    () => ({ ...params, run: { ...params.run, massKg: baselineCar.massKg } }),
    [params, baselineCar],
  )
  const baselineResult = useMemo(
    () => calculateAero(baselineCar, baselineParams),
    [baselineCar, baselineParams],
  )

  const updateRun = <K extends keyof RunConditions>(key: K, value: RunConditions[K]) => {
    setParams((current) => ({ ...current, run: { ...current.run, [key]: value } }))
  }
  const updateDriver = <K extends keyof DriverControls>(key: K, value: DriverControls[K]) => {
    setParams((current) => ({ ...current, driver: { ...current.driver, [key]: value } }))
  }
  const updateGarage = <K extends keyof GarageSetup>(key: K, value: GarageSetup[K]) => {
    setParams((current) => ({ ...current, garage: { ...current.garage, [key]: value } }))
  }
  const updateDesign = <K extends keyof AeroDesign>(key: K, value: AeroDesign[K]) => {
    setParams((current) => ({ ...current, design: { ...current.design, [key]: value } }))
  }

  const selectCar = (id: string) => {
    setSelectedCarId(id)
    const nextCar = cars.find((car) => car.id === id)
    if (nextCar) {
      setParams((current) => ({ ...current, run: { ...current.run, massKg: nextCar.massKg } }))
    }
    if (id === baselineCarId) {
      const alternate = availableCars.find((car) => car.id !== id)
      if (alternate) setBaselineCarId(alternate.id)
    }
  }

  const selectRuleset = (ruleset: Ruleset) => {
    const eligible = carsForRuleset(ruleset)
    const nextSelected = eligible.find((car) => car.id === selectedCarId) ?? eligible[0]
    if (!nextSelected) return
    const nextBaseline = eligible.find((car) => car.id === baselineCarId && car.id !== nextSelected.id)
      ?? eligible.find((car) => car.id !== nextSelected.id)
      ?? nextSelected
    setSelectedCarId(nextSelected.id)
    setBaselineCarId(nextBaseline.id)
    setParams((current) => ({
      ...current,
      ruleset,
      run: { ...current.run, massKg: nextSelected.massKg },
    }))
  }

  const resetSetup = () => setParams(defaultParams(selectedCar))
  const runCode = `${selectedCar.code}-${Math.round(params.run.speedKph).toString().padStart(3, '0')}`

  return (
    <div className="app-shell" style={{ '--car-accent': selectedCar.accent } as CSSProperties}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="空气动力实验室首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="brand-word">AERO<span>LAB</span></span>
        </a>
        <div className="topbar__route"><span>F1 / 空气动力学</span><b>风洞 01</b></div>
        <div className="topbar__status"><span className="status-dot" /> 仿真核心在线 <span className="topbar__version">v0.1 / 趋势版</span></div>
      </header>

      <main className="app-main">
        <section className="hero">
          <div className="hero__copy">
            <div className="eyebrow">赛车工程工作台 <span>//</span> 仿真模式</div>
            <h1>空气动力<span>//</span>探索器</h1>
            <p>观察气流，读取载荷，寻找单圈速度的最佳平衡。</p>
          </div>
          <div className="hero__telemetry" aria-label="当前工况信息">
            <div><span>工况编号</span><strong>{runCode}</strong></div>
            <div><span>规则版本</span><strong>{params.ruleset === '2026' ? '2026 主动气动' : '2022–25 DRS'}</strong></div>
            <div><span>状态</span><strong className="is-green">{result.activeAeroMode === 'straight' ? '直道' : '弯道'}</strong></div>
          </div>
        </section>

        <div className="workspace-grid">
          <Controls
            cars={availableCars}
            selectedCarId={selectedCarId}
            baselineCarId={baselineCarId}
            params={params}
            onSelectCar={selectCar}
            onSelectBaseline={setBaselineCarId}
            onRulesetChange={selectRuleset}
            onRunChange={updateRun}
            onDriverChange={updateDriver}
            onGarageChange={updateGarage}
            onDesignChange={updateDesign}
            onReset={resetSetup}
            referenceMode={referenceCapability.referenceMode}
            referenceWingAdjustable={referenceCapability.wingAdjustable}
          />

          <section className="visual-column">
            <WindTunnelView
              car={selectedCar}
              params={params}
              result={result}
              onReferenceCapabilityChange={setReferenceCapability}
            />
            <MetricsPanel car={selectedCar} result={result} />
            <ComparisonPanel
              activeCar={selectedCar}
              baselineCar={baselineCar}
              active={result}
              baseline={baselineResult}
            />
          </section>
        </div>
      </main>

      <footer className="app-footer">
        <span>APEX 空气动力实验室 / 内部概念工具</span>
        <span>ρ 1.225 KG/M³ · g 9.81 M/S² · {selectedCar.name.toUpperCase()}</span>
        <span>所有数值均为估算</span>
      </footer>
    </div>
  )
}

export default App
