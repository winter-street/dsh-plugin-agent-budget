declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface SlotsService {
    inject(name: string, register: () => unknown): unknown
    register(options: {
      name: string
      id: string
      order?: number
      label: () => string
      component: () => {
        render(): { dispose?: () => void }
      }
    }): unknown
  }
}
