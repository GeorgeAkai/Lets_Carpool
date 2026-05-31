declare module "react-native-web" {
  import type { ComponentType, PropsWithChildren } from "react";

  export const Text: ComponentType<PropsWithChildren<Record<string, unknown>>>;
  export const View: ComponentType<PropsWithChildren<Record<string, unknown>>>;
}
