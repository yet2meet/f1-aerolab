import { useState } from 'react'
import type {
  AeroDesign,
  CarSpec,
  DriverControls,
  GarageSetup,
  Ruleset,
  RunConditions,
  SimulationParams,
} from '../types'

type ControlsProps = {
  cars: CarSpec[]
  selectedCarId: string
  baselineCarId: string
  params: SimulationParams
  onSelectCar: (id: string) => void
  onSelectBaseline: (id: string) => void
  onRulesetChange: (ruleset: Ruleset) => void
  onRunChange: <K extends keyof RunConditions>(key: K, value: RunConditions[K]) => void
  onDriverChange: <K extends keyof DriverControls>(key: K, value: DriverControls[K]) => void
  onGarageChange: <K extends keyof GarageSetup>(key: K, value: GarageSetup[K]) => void
  onDesignChange: <K extends keyof AeroDesign>(key: K, value: AeroDesign[K]) => void
  onReset: () => void
  referenceMode: boolean
  referenceWingAdjustable: boolean
}

type RangeControlProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
  hint?: string
  disabled?: boolean
}

const RangeControl = ({ label, value, min, max, step, unit, onChange, hint, disabled = false }: RangeControlProps) => (
  <div className={`range-control${disabled ? ' is-disabled' : ''}`}>
    <div className="range-control__header">
      <label>{label}</label>
      <output>
        {Number.isInteger(step) ? Math.round(value) : value.toFixed(1)}
        <span>{unit}</span>
      </output>
    </div>
    <input
      aria-label={label}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    />
    {hint && <p className="control-hint">{hint}</p>}
  </div>
)

const Toggle = ({
  label,
  checked,
  onChange,
  disabled = false,
  badge,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  badge?: string
}) => (
  <label className={`toggle-row${disabled ? ' is-disabled' : ''}`}>
    <span>
      {label}
      {badge && <small>{badge}</small>}
    </span>
    <input
      aria-label={label}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <i aria-hidden="true" />
  </label>
)

export const Controls = ({
  cars,
  selectedCarId,
  baselineCarId,
  params,
  onSelectCar,
  onSelectBaseline,
  onRulesetChange,
  onRunChange,
  onDriverChange,
  onGarageChange,
  onDesignChange,
  onReset,
  referenceMode,
  referenceWingAdjustable,
}: ControlsProps) => {
  const isLegacy = params.ruleset === '2022-2025'
  const referenceGeometryLocked = referenceMode && !referenceWingAdjustable
  const [openSection, setOpenSection] = useState<'identity' | 'run' | 'driver' | 'garage' | 'design' | null>('identity')
  const toggleSection = (section: NonNullable<typeof openSection>) => (
    setOpenSection((current) => current === section ? null : section)
  )

  return (
    <aside className="control-panel" aria-label="风洞设置控制">
      <div className="panel-kicker">
        <span>设置输入 / 04 个分组</span>
        <button type="button" onClick={onReset}>重置 ↺</button>
      </div>

      <details className="control-section control-section--identity" open={openSection === 'identity'}>
        <summary className="section-heading" onClick={(event) => { event.preventDefault(); toggleSection('identity') }}>
          <span className="section-index">00</span>
          <div>
            <h2>赛车 / 参考模型</h2>
            <p>选择并对比参数化赛车概念</p>
          </div>
        </summary>
        <label className="select-label">
          当前赛车
          <select
            aria-label="当前赛车"
            value={selectedCarId}
            onChange={(event) => onSelectCar(event.target.value)}
          >
            {cars.map((car) => (
              <option key={car.id} value={car.id}>
                {car.code} / {car.name}
              </option>
            ))}
          </select>
        </label>
        <label className="select-label">
          对比基准
          <select
            aria-label="基准对比赛车"
            value={baselineCarId}
            onChange={(event) => onSelectBaseline(event.target.value)}
          >
            {cars.filter((car) => car.id !== selectedCarId).map((car) => (
              <option key={car.id} value={car.id}>
                {car.code} / {car.name}
              </option>
            ))}
          </select>
        </label>
        <label className="select-label">
          规则版本
          <select
            aria-label="空气动力规则版本"
            value={params.ruleset}
            onChange={(event) => onRulesetChange(event.target.value as Ruleset)}
          >
            <option value="2026">2026 / 主动空气动力学</option>
            <option value="2022-2025">2022–25 / 传统 DRS</option>
          </select>
        </label>
        <p className="rule-note">
          {isLegacy
            ? 'DRS 仅作为 2022–2025 规则下的后翼控制显示。'
            : '2026 默认：前后主动翼面按照同一气动状态联动。'}
        </p>
      </details>

      <details className="control-section" open={openSection === 'run'}>
        <summary className="section-heading" onClick={(event) => { event.preventDefault(); toggleSection('run') }}>
          <span className="section-index">A</span>
          <div>
            <h2>运行条件</h2>
            <p>本次工况的速度与总质量</p>
          </div>
        </summary>
        <RangeControl
          label="风速 / 车速"
          value={params.run.speedKph}
          min={0}
          max={360}
          step={5}
          unit="KM/H"
          onChange={(value) => onRunChange('speedKph', value)}
          hint="动压与速度的平方成正比"
        />
        <RangeControl
          label="总质量 / 燃油 + 车手"
          value={params.run.massKg}
          min={740}
          max={900}
          step={1}
          unit="KG"
          onChange={(value) => onRunChange('massKg', value)}
        />
      </details>

      <details className="control-section" open={openSection === 'driver'}>
        <summary className="section-heading" onClick={(event) => { event.preventDefault(); toggleSection('driver') }}>
          <span className="section-index">B</span>
          <div>
            <h2>车手 / 赛道状态</h2>
            <p>驾驶舱可选状态</p>
          </div>
        </summary>
        <fieldset className={`mode-control${isLegacy || referenceGeometryLocked ? ' is-disabled' : ''}`} disabled={isLegacy || referenceGeometryLocked}>
          <legend>主动空气动力学状态 / 2026</legend>
          <div className="segmented-control">
            <label>
              <input
                type="radio"
                name="active-aero-mode"
                value="straight"
                checked={params.driver.activeAeroMode === 'straight'}
                onChange={() => onDriverChange('activeAeroMode', 'straight')}
              />
              <span>直道 / 低阻</span>
            </label>
            <label>
              <input
                type="radio"
                name="active-aero-mode"
                value="corner"
                checked={params.driver.activeAeroMode === 'corner'}
                onChange={() => onDriverChange('activeAeroMode', 'corner')}
              />
              <span>弯道 / 高下压力</span>
            </label>
          </div>
          {(isLegacy || referenceGeometryLocked) && <p className="control-hint">
            {isLegacy
              ? '传统规则版本不提供 2026 主动空气动力学状态。'
              : '当前参考模型没有已验证的主动翼面节点；请切换分析模型。'}
          </p>}
        </fieldset>
        <RangeControl
          label="前制动偏置"
          value={params.driver.brakeBiasFrontPercent}
          min={45}
          max={60}
          step={0.5}
          unit="%"
          onChange={(value) => onDriverChange('brakeBiasFrontPercent', value)}
          hint="车手设定的制动力分配目标"
        />
      </details>

      <details className="control-section" open={openSection === 'garage'}>
        <summary className="section-heading" onClick={(event) => { event.preventDefault(); toggleSection('garage') }}>
          <span className="section-index">C</span>
          <div>
            <h2>车库设置</h2>
            <p>机械平台与翼面设定</p>
          </div>
        </summary>
        <div className="split-control">
          <RangeControl
            label="前离地高度"
            value={params.garage.frontRideHeightMm}
            min={15}
            max={70}
            step={1}
            unit="MM"
            onChange={(value) => onGarageChange('frontRideHeightMm', value)}
            disabled={referenceMode}
            hint={referenceMode ? '参考模型尚无已验证的车高语义节点' : undefined}
          />
          <RangeControl
            label="后离地高度"
            value={params.garage.rearRideHeightMm}
            min={20}
            max={90}
            step={1}
            unit="MM"
            onChange={(value) => onGarageChange('rearRideHeightMm', value)}
            disabled={referenceMode}
            hint={referenceMode ? '参考模型尚无已验证的车高语义节点' : undefined}
          />
        </div>
        <div className="split-control">
          <RangeControl
            label="悬挂平台刚度"
            value={params.garage.suspensionStiffnessPercent}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(value) => onGarageChange('suspensionStiffnessPercent', value)}
            hint="影响底板工作姿态的稳定程度"
          />
          <RangeControl
            label="防倾杆刚度"
            value={params.garage.antiRollBarPercent}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(value) => onGarageChange('antiRollBarPercent', value)}
          />
        </div>
        <div className="split-control">
          <RangeControl
            label="轮胎气压"
            value={params.garage.tirePressurePsi}
            min={18}
            max={28}
            step={0.1}
            unit="PSI"
            onChange={(value) => onGarageChange('tirePressurePsi', value)}
            hint="当前趋势模型在约 22 psi 时滚阻最低"
          />
          <RangeControl
            label="前翼 / 攻角"
            value={params.garage.frontWingAngleDeg}
            min={5}
            max={25}
            step={0.5}
            unit="DEG"
          onChange={(value) => onGarageChange('frontWingAngleDeg', value)}
          disabled={referenceGeometryLocked}
          hint={referenceGeometryLocked
            ? '当前参考模型没有已验证的前翼节点'
            : referenceMode ? '参考模型：主翼固定于鼻锥，攻角通过前翼襟翼调整' : undefined}
          />
        </div>
        <RangeControl
          label="前翼襟翼 / 弯度"
          value={params.garage.frontFlapPercent}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(value) => onGarageChange('frontFlapPercent', value)}
          disabled={referenceGeometryLocked}
          hint={referenceGeometryLocked ? '当前参考模型没有已验证的前翼襟翼节点' : undefined}
        />
        <RangeControl
          label="尾翼 / 下压力级别"
          value={params.garage.rearWingLoadPercent}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(value) => onGarageChange('rearWingLoadPercent', value)}
          disabled={referenceGeometryLocked}
          hint={referenceGeometryLocked ? '当前参考模型没有已验证的尾翼节点' : undefined}
        />
        <Toggle
          label="DRS 开启"
          checked={params.garage.drsOpen}
          onChange={(value) => onGarageChange('drsOpen', value)}
          disabled={!isLegacy || referenceGeometryLocked}
          badge="仅限 2022–25"
        />
      </details>

      <details className="control-section" open={openSection === 'design'}>
        <summary className="section-heading" onClick={(event) => { event.preventDefault(); toggleSection('design') }}>
          <span className="section-index">D</span>
          <div>
            <h2>空气动力设计</h2>
            <p>文丘里底板系统与扩散器几何</p>
          </div>
        </summary>
        <RangeControl
          label="底板喉部 / 密封强度"
          value={params.design.floorThroatSealPercent}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(value) => onDesignChange('floorThroatSealPercent', value)}
          hint={referenceMode ? '参考模型尚无已验证的底板语义节点' : '喉部压力恢复趋势'}
          disabled={referenceMode}
        />
        <RangeControl
          label="底板边缘 / 涡流控制"
          value={params.design.floorEdgeSealPercent}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(value) => onDesignChange('floorEdgeSealPercent', value)}
          hint={referenceMode ? '参考模型尚无已验证的底板边缘节点' : '底板边缘涡流管理'}
          disabled={referenceMode}
        />
        <RangeControl
          label="扩散器 / 斜坡角度"
          value={params.design.diffuserAngleDeg}
          min={5}
          max={15}
          step={0.5}
          unit="DEG"
          onChange={(value) => onDesignChange('diffuserAngleDeg', value)}
          disabled={referenceMode}
          hint={referenceMode ? '参考模型尚无已验证的扩散器语义节点' : undefined}
        />
        <p className="floor-note">
          <span aria-hidden="true">⌁</span> 文丘里底板系统——喉部、边缘涡流和扩散器几何共同决定地面效应方案。
        </p>
      </details>
    </aside>
  )
}
