export interface AppEntry {
  id: string
  name: string
  path: string
  icon: string | null
  group: string | null
  sort_order: number | null
}

export interface CustomIcon {
  id: string
  name: string
  data_uri: string
}
