import { filter, groupBy, includes, isEmpty, keyBy, map as mapToArray, maxBy, minBy, size, sortBy } from 'lodash'
import { inspect } from 'util'

import { EXECUTION_DELAY, debug } from './utils'

const MINUTES_OF_HISTORICAL_DATA = 30

// CPU threshold in percent.
export const DEFAULT_CRITICAL_THRESHOLD_CPU = 90.0

// Memory threshold in MB.
export const DEFAULT_CRITICAL_THRESHOLD_MEMORY_FREE = 64.0

// Thresholds factors.
const HIGH_THRESHOLD_FACTOR = 0.85
const LOW_THRESHOLD_FACTOR = 0.25

const HIGH_THRESHOLD_MEMORY_FREE_FACTOR = 1.25
const LOW_THRESHOLD_MEMORY_FREE_FACTOR = 20.0

const numberOrDefault = (value, def) => (value >= 0 ? value : def)

// ===================================================================
// Averages.
// ===================================================================

function computeAverage(values, nPoints) {
  if (values === undefined) {
    return
  }

  let sum = 0
  let tot = 0

  const { length } = values
  const start = nPoints !== undefined ? length - nPoints : 0

  for (let i = start; i < length; i++) {
    const value = values[i]

    sum += value || 0

    if (value) {
      tot += 1
    }
  }

  return sum / tot
}

function computeRessourcesAverage(objects, objectsStats, nPoints) {
  const averages = {}

  for (const object of objects) {
    const { id } = object
    const { stats } = objectsStats[id]

    averages[id] = {
      cpu: computeAverage(mapToArray(stats.cpus, cpu => computeAverage(cpu, nPoints))),
      nCpus: size(stats.cpus),
      memoryFree: computeAverage(stats.memoryFree, nPoints),
      memory: computeAverage(stats.memory, nPoints),
    }
  }

  return averages
}

function computeRessourcesAverageWithWeight(averages1, averages2, ratio) {
  const averages = {}

  for (const id in averages1) {
    const objectAverages = (averages[id] = {})

    for (const averageName in averages1[id]) {
      const average1 = averages1[id][averageName]
      if (average1 === undefined) {
        continue
      }

      objectAverages[averageName] = average1 * ratio + averages2[id][averageName] * (1 - ratio)
    }
  }

  return averages
}

function setRealCpuAverageOfVms(vms, vmsAverages, nCpus) {
  for (const vm of vms) {
    const averages = vmsAverages[vm.id]
    averages.cpu *= averages.nCpus / nCpus
  }
}

// ===================================================================

export default class Plan {
  constructor(xo, name, poolIds, { excludedHosts, thresholds, antiAffinityTags } = {}) {
    this.xo = xo
    this._name = name
    this._poolIds = poolIds
    this._excludedHosts = excludedHosts
    this._thresholds = {
      cpu: {
        critical: numberOrDefault(thresholds && thresholds.cpu, DEFAULT_CRITICAL_THRESHOLD_CPU),
      },
      memoryFree: {
        critical: numberOrDefault(thresholds && thresholds.memoryFree, DEFAULT_CRITICAL_THRESHOLD_MEMORY_FREE) * 1024,
      },
    }
    this._antiAffinityTags = antiAffinityTags

    for (const key in this._thresholds) {
      const attr = this._thresholds[key]
      const { critical } = attr

      if (key === 'memoryFree') {
        attr.high = critical * HIGH_THRESHOLD_MEMORY_FREE_FACTOR
        attr.low = critical * LOW_THRESHOLD_MEMORY_FREE_FACTOR
      } else {
        attr.high = critical * HIGH_THRESHOLD_FACTOR
        attr.low = critical * LOW_THRESHOLD_FACTOR
      }
    }
  }

  execute() {
    throw new Error('Not implemented')
  }

  // ===================================================================
  // Get hosts to optimize.
  // ===================================================================

  async _getHostStatsAverages({ hosts, toOptimizeOnly = false }) {
    const hostsStats = await this._getHostsStats(hosts, 'minutes')

    const avgNow = computeRessourcesAverage(hosts, hostsStats, EXECUTION_DELAY)
    let toOptimize
    if (toOptimizeOnly) {
      // Check if a ressource utilization exceeds threshold.
      toOptimize = this._checkRessourcesThresholds(hosts, avgNow)
      if (toOptimize.length === 0) {
        debug('No hosts to optimize.')
        return
      }
    }

    const avgBefore = computeRessourcesAverage(hosts, hostsStats, MINUTES_OF_HISTORICAL_DATA)
    const avgWithRatio = computeRessourcesAverageWithWeight(avgNow, avgBefore, 0.75)

    if (toOptimizeOnly) {
      // Check in the last 30 min interval with ratio.
      toOptimize = this._checkRessourcesThresholds(toOptimize, avgWithRatio)
      if (toOptimize.length === 0) {
        debug('No hosts to optimize.')
        return
      }
    }

    return {
      toOptimize,
      averages: avgWithRatio,
    }
  }

  _checkRessourcesThresholds() {
    throw new Error('Not implemented')
  }

  // ===================================================================
  // Get objects.
  // ===================================================================

  _getPlanPools() {
    const pools = {}

    try {
      for (const poolId of this._poolIds) {
        pools[poolId] = this.xo.getObject(poolId)
      }
    } catch (_) {
      return {}
    }

    return pools
  }

  // Compute hosts for each pool. They can change over time.
  _getHosts({ powerState = 'Running' } = {}) {
    return filter(
      this.xo.getObjects(),
      object =>
        object.type === 'host' &&
        includes(this._poolIds, object.$poolId) &&
        object.power_state === powerState &&
        !includes(this._excludedHosts, object.id)
    )
  }

  _getAllRunningVms() {
    return filter(
      this.xo.getObjects(),
      object => object.type === 'VM' && object.power_state === 'Running'
    )
  }

  // ===================================================================
  // Get stats.
  // ===================================================================

  async _getHostsStats(hosts, granularity) {
    const hostsStats = {}

    await Promise.all(
      mapToArray(hosts, host =>
        this.xo.getXapiHostStats(host, granularity).then(hostStats => {
          hostsStats[host.id] = {
            nPoints: hostStats.stats.cpus[0].length,
            stats: hostStats.stats,
            averages: {},
          }
        })
      )
    )

    return hostsStats
  }

  async _getVmsStats(vms, granularity) {
    const vmsStats = {}

    await Promise.all(
      mapToArray(vms, vm =>
        this.xo.getXapiVmStats(vm, granularity).then(vmStats => {
          vmsStats[vm.id] = {
            nPoints: vmStats.stats.cpus[0].length,
            stats: vmStats.stats,
            averages: {},
          }
        })
      )
    )

    return vmsStats
  }

  async _getVmsAverages(vms, hosts) {
    const vmsStats = await this._getVmsStats(vms, 'minutes')
    const vmsAverages = computeRessourcesAverageWithWeight(
      computeRessourcesAverage(vms, vmsStats, EXECUTION_DELAY),
      computeRessourcesAverage(vms, vmsStats, MINUTES_OF_HISTORICAL_DATA),
      0.75
    )

    // Compute real CPU usage. Virtuals cpus to reals cpus.
    for (const [hostId, hostVms] of Object.entries(groupBy(vms, '$container'))) {
      setRealCpuAverageOfVms(hostVms, vmsAverages, hosts[hostId].CPUs.cpu_count)
    }

    return vmsAverages
  }

  // ===================================================================
  // Anti-affinity helpers
  // ===================================================================

  async _processAntiAffinity() {
    if (!this._antiAffinityTags.length) {
      return
    }

    const allHosts = await this._getHosts()
    if (allHosts.length <= 1) {
      return
    }
    const idToHost = keyBy(allHosts, 'id')

    const allVms = filter(this._getAllRunningVms(), vm => vm.$container in idToHost)
    const taggedHosts = Object.values(this._getAntiAffinityTaggedHosts(allHosts, allVms))

    // 1. Check if we must migrate VMs...
    const tagsDiff = {}
    for (const watchedTag of this._antiAffinityTags) {
      const getCount = fn => fn(taggedHosts, host => host.tags[watchedTag]).tags[watchedTag]
      const diff = getCount(maxBy) - getCount(minBy)
      if (diff > 1) {
        tagsDiff[watchedTag] = diff - 1
      }
    }

    if (isEmpty(tagsDiff)) {
      return
    }

    // 2. Migrate!
    debug('Try to apply anti-affinity policy.')
    debug(`VM tag count per host: ${inspect(taggedHosts, { depth: null })}.`)
    debug(`Tags diff: ${inspect(tagsDiff, { depth: null })}.`)

    const vmsAverages = await this._getVmsAverages(allVms, idToHost)
    const { averages: hostsAverages } = this._getHostStatsAverages({ hosts: allHosts })

    const promises = []

    for (const tag in tagsDiff) {
      while (true) {
        // 2.a. Find source host from which to migrate.
        const sources = sortBy(
          filter(taggedHosts, host => host.tags[tag] > 1),
          host => host.tags[tag]
        )
        if (!sources.length) {
          break // Nothing to migrate!
        }
        const srcHost = sources[sources.length - 1]

        // 2.b. Find destination host, ideally it would be interesting to migrate in the same pool.
        const destinations = sortBy(
          filter(taggedHosts, host => host.id !== srcHost.id),
          host => host.tags[tag],
          host => host.poolId !== srcHost.poolId
        )
        if (!destinations.length) {
          break // Cannot find a valid destination.
        }
        const destHost = destinations[0]

        // 2.c. Build VM list to migrate.
        // We try to migrate VMs with the targeted tag and with the fewest watched tags.
        const vms = sortBy(
          filter(srcHost.vms, vm => vm.tags.includes(tag)),
          vm => vm.tags.length
        )

        debug(`Tagged VM ("${tag}") candidates to migrate from host ${srcHost.id}: ${inspect(mapToArray(vms, 'id'))}.`)
        const vm = this._getAntiAffinityVmToMigrate(vms, vmsAverages, hostsAverages, taggedHosts)
        if (!vm) {
          break // If we can't find a VM to migrate, go to the next tag!
        }
        debug(`Migrate VM (${vm.id}) to Host (${destHost.id}) from Host (${srcHost.id}).`)

        for (const tag of vm.tags) {
          if (this._antiAffinityTags.includes(tag)) {
            srcHost.tags[tag]--
            destHost.tags[tag]++
          }
        }

        delete srcHost.vms[vm.id]

        // TODO: Remove
        break
        /* eslint-disable-next-line no-unreachable */
        const destination = idToHost[destHost.id]
        promises.push(this.xo.getXapi(idToHost[srcHost.id]).migrateVm(
          vm._xapiId, this.xo.getXapi(destination), destination._xapiId
        ))
      }
    }

    // 3. Done!
    debug(`VM tag count per host after migration: ${inspect(taggedHosts, { depth: null })}.`)
    await Promise.all(promises)
  }

  _getAntiAffinityTaggedHosts(hosts, vms) {
    const taggedHosts = {}
    for (const host of hosts) {
      const tags = {}
      for (const tag of this._antiAffinityTags) {
        tags[tag] = 0
      }

      const taggedHost = taggedHosts[host.id] = {
        id: host.id,
        poolId: host.$poolId,
        tags,
        vms: {}
      }

      // Hide properties when util.inspect is used.
      for (const property of ['id', 'poolId', 'vms']) {
        Object.defineProperty(taggedHost, property, { enumerable: false })
      }
    }

    for (const vm of vms) {
      const hostId = vm.$container
      if (!(hostId in taggedHosts)) {
        continue
      }

      const taggedHost = taggedHosts[hostId]

      for (const tag of vm.tags) {
        if (this._antiAffinityTags.includes(tag)) {
          taggedHost.tags[tag]++
          taggedHost.vms[vm.id] = vm
        }
      }
    }

    return taggedHosts
  }

  _getAntiAffinityVmToMigrate(vms, vmsAverages, hostsAverages, taggedHosts) {
    // At this point the VMs must be ordered from the smallest number of tags to the largest.
    // TODO: Ask to performance algorithm to sort VMs to reduce performance impact.
    return vms[0]
  }
}
