import { useState, type ReactNode } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { IconButton } from './WorkspacePrimitives'
import './ordered-list.css'

function OrderedRow({
  id,
  index,
  count,
  label,
  disabled,
  onMove,
  children,
}: {
  id: string
  index: number
  count: number
  label: string
  disabled: boolean
  onMove: (from: number, to: number) => void
  children: ReactNode
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled })
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
      }}
      className={isDragging ? 'drag-over' : ''}
    >
      <button
        type="button"
        className="icon-button order-handle"
        ref={setActivatorNodeRef}
        disabled={disabled}
        {...attributes}
        {...listeners}
        aria-label={`拖动排序 ${label}`}
        title="拖动排序；空格开始键盘拖动，方向键移动，空格放下"
        onKeyDown={(event) => {
          if (isDragging && event.key === 'Escape') {
            // Let dnd-kit's document listener cancel the drag, while the modal
            // respects defaultPrevented and keeps the unsaved form open.
            event.preventDefault()
          } else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault()
            onMove(index, index + (event.key === 'ArrowUp' ? -1 : 1))
          } else listeners?.onKeyDown?.(event)
        }}
      >
        <GripVertical size={16} />
      </button>
      <span className="order-index">{index + 1}</span>
      <div className="ordered-list-content">{children}</div>
      <div className="row-actions">
        <IconButton
          icon={ArrowUp}
          label={`上移 ${label}`}
          disabled={disabled || index === 0}
          onClick={() => onMove(index, index - 1)}
        />
        <IconButton
          icon={ArrowDown}
          label={`下移 ${label}`}
          disabled={disabled || index === count - 1}
          onClick={() => onMove(index, index + 1)}
        />
      </div>
    </li>
  )
}

/** Reusable sorting for pointer, touch and keyboard, with explicit arrow controls. */
export function OrderedList<T>({
  items,
  itemKey,
  label,
  render,
  onMove,
  disabled = false,
}: {
  items: T[]
  itemKey: (item: T) => string
  label: (item: T) => string
  render: (item: T) => ReactNode
  onMove: (from: number, to: number) => void
  disabled?: boolean
}) {
  const [announcement, setAnnouncement] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const keys = items.map(itemKey)
  const move = (from: number, to: number) => {
    if (disabled || from === to || from < 0 || to < 0 || to >= items.length) return
    onMove(from, to)
    setAnnouncement(`${label(items[from])} 已移至第 ${to + 1} 位`)
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (over) move(keys.indexOf(String(active.id)), keys.indexOf(String(over.id)))
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable: '按空格开始拖动，使用方向键移动，空格放下，Escape 取消。',
        },
        announcements: {
          onDragStart: ({ active }) => `正在移动 ${active.id}`,
          onDragOver: ({ over }) =>
            over ? `目标位置 ${keys.indexOf(String(over.id)) + 1}` : undefined,
          onDragEnd: ({ active }) => `${active.id} 排序完成`,
          onDragCancel: () => '已取消拖动',
        },
      }}
    >
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        <ol className="ordered-list">
          {items.map((item, index) => (
            <OrderedRow
              key={itemKey(item)}
              id={itemKey(item)}
              index={index}
              count={items.length}
              label={label(item)}
              disabled={disabled}
              onMove={move}
            >
              {render(item)}
            </OrderedRow>
          ))}
        </ol>
      </SortableContext>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </DndContext>
  )
}
