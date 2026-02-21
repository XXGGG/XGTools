<script setup lang="ts">
import { useDockStore } from './dockStore'

const store = useDockStore()
</script>

<template>
  <div class="flex items-center gap-2.5">
    <button
      v-for="page in store.totalPages"
      :key="page - 1"
      class="w-2.5 h-2.5 rounded-full transition-all duration-300"
      :class="store.currentPage === page - 1 ? 'bg-white/90' : 'bg-white/30 hover:bg-white/60'"
      @click="store.setPage(page - 1)"
    />
  </div>
</template>
