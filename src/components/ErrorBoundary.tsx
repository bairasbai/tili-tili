import { Component, type ReactNode } from 'react'

/** Глобальный предохранитель: падение одного экрана не должно класть всё приложение. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[tilitili] render crash:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-shell min-h-dvh flex flex-col items-center justify-center px-8 text-center">
          <span className="text-[44px]">💐</span>
          <h1 className="font-serif-d text-[22px] mt-4">Что-то пошло не так</h1>
          <p className="text-[12px] text-[#93897F] mt-2 leading-relaxed">
            Экран столкнулся с ошибкой. Ваши данные сохранены — просто обновите.
          </p>
          <button
            onClick={() => { this.setState({ error: null }); location.assign('/') }}
            className="press mt-6 px-8 py-3.5 rounded-full grad text-white text-[13px] font-semibold"
            style={{ boxShadow: '0 16px 36px -12px rgba(201,138,138,.65)' }}
          >
            Вернуться на главную
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
