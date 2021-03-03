import Plan from './plan'

// ===================================================================

export default class SimplePlan extends Plan {
  async execute() {
    this._processAntiAffinity()
  }
}
