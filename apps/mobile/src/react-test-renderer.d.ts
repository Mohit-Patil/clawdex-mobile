declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export interface ReactTestInstance {
    props: Record<string, unknown>;
    findByType(type: unknown): ReactTestInstance;
    findByProps(props: Record<string, unknown>): ReactTestInstance;
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    update(element: ReactElement): void;
    unmount(): void;
  }

  const renderer: {
    create(element: ReactElement): ReactTestRenderer;
  };

  export function act(callback: () => void): void;

  export default renderer;
}
