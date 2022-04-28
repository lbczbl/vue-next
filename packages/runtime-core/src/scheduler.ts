import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'
// 任务的数据结构
export interface SchedulerJob extends Function {
  id?: number
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean // 是否允许递归触发本身
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

let isFlushing = false
let isFlushPending = false

const queue: SchedulerJob[] = [] // 队列
let flushIndex = 0

const pendingPreFlushCbs: SchedulerJob[] = []
let activePreFlushCbs: SchedulerJob[] | null = null
let preFlushIndex = 0

const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

const resolvedPromise: Promise<any> = Promise.resolve()
let currentFlushPromise: Promise<void> | null = null

let currentPreFlushParentJob: SchedulerJob | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void>(
  this: T,
  fn?: (this: T) => void
): Promise<void> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < id ? (start = middle + 1) : (end = middle)
  }

  return start
}
// 加入队列
export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  if (
    (!queue.length ||
      !queue.includes(
        // 去重判断
        job, // isFlushing 表示正在执行队列 flushIndex 当前正在执行的job的index
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    job !== currentPreFlushParentJob
  ) {
    if (job.id == null) {
      // 没有id放最后
      queue.push(job)
    } else {
      // 二分查找job.id, 找出需要插入的位置
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    queueFlush()
  }
}
// 队列执行时机的实现
function queueFlush() {
  // 如果不是正在执行队列 / 等待执行队列
  if (!isFlushing && !isFlushPending) {
    // 标记为等待执行队列
    isFlushPending = true
    // 在下一个微任务执行队列
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}
// 删除Job
export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

function queueCb(
  cb: SchedulerJobs,
  activeQueue: SchedulerJob[] | null,
  pendingQueue: SchedulerJob[],
  index: number
) {
  if (!isArray(cb)) {
    if (
      // 去重判断
      !activeQueue ||
      !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)
    ) {
      pendingQueue.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    // 如果cb是一个数组，它只能是在一个job内触发的组件生命周期hook,并且这些cb已经去重过了，可以跳过去重判断
    pendingQueue.push(...cb)
  }
  queueFlush()
}

export function queuePreFlushCb(cb: SchedulerJob) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}

export function queuePostFlushCb(cb: SchedulerJobs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

export function flushPreFlushCbs(
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  // 有Job才执行
  if (pendingPreFlushCbs.length) {
    currentPreFlushParentJob = parentJob
    // 执行前去重，并赋值到 activePreFlushCbs
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)]
    // 将等待执行的Pre队列清空
    pendingPreFlushCbs.length = 0
    if (__DEV__) {
      seen = seen || new Map()
    }
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      if (
        // 开发模式下，校验无限递归的情况
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }
      // 执行Job
      activePreFlushCbs[preFlushIndex]()
    }
    // 置空
    activePreFlushCbs = null
    preFlushIndex = 0
    currentPreFlushParentJob = null
    // recursively flush until it drains
    // 可能递归，再次执行 flushPreFlushCbs， 如果队列为空就停止
    flushPreFlushCbs(seen, parentJob)
  }
}

export function flushPostFlushCbs(seen?: CountMap) {
  // 队列为空则结束
  if (pendingPostFlushCbs.length) {
    // 去重
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 特殊情况，发生了递归，在执行前 activePostFlushCbs 已经有值了
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }
    // 优先级排序
    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))
    // 循环执行Job
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    // 清空
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id
// 队列的执行， 即清空所有任务
function flushJobs(seen?: CountMap) {
  // 首先将等待状态设置为 false
  isFlushPending = false
  // 将队列标记为正在执行状态
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }
  // 执行 Pre 队列
  flushPreFlushCbs(seen)

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  queue.sort((a, b) => getId(a) - getId(b)) //根据id大小进行优先级排序

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job) // 检测是否递归
    : NOOP

  try {
    // 循环组件异步更新队列，执行job
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      // 仅在active时才调用job
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        // 执行job函数，并带有Vue内部的错误处理
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    // 清空 queue 队列
    flushIndex = 0
    queue.length = 0
    // 执行Post 队列
    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    if (
      // 如果还有Job,继续执行队列
      // Post 队列运行过程中，可能又会将Job 加入进来，会在下一轮flushJob执行
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
