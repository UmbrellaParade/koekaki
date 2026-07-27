import type { Mode } from '../lib/types'
import { PlusIcon } from './Icons'

interface ModeBarProps {
  modes: Mode[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  disabled: boolean
}

export function ModeBar({ modes, activeId, onSelect, onAdd, disabled }: ModeBarProps) {
  return (
    <nav className="modebar" aria-label="整形モード">
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          className={`mode-chip${mode.id === activeId ? ' active' : ''}`}
          onClick={() => onSelect(mode.id)}
          disabled={disabled}
          aria-pressed={mode.id === activeId}
        >
          <span aria-hidden="true">{mode.emoji}</span>
          {mode.name}
        </button>
      ))}
      <button type="button" className="mode-chip add" onClick={onAdd} disabled={disabled}>
        <PlusIcon />
        モード
      </button>
    </nav>
  )
}
