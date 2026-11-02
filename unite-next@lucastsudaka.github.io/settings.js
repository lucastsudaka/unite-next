import { Signals } from './resources.js'

export class Settings extends Signals {
  constructor(context) {
    super()
    this.objects = Object.values(context.settings)
  }

  getSettingObject(key) {
    const object = this.objects.find(settings => settings.exists(key))
    if (!object) throw new Error(`Unknown Unite setting: ${key}`)
    return object
  }

  connect(name, callback) {
    const object = this.getSettingObject(name)
    return this.registerHandler(object, `changed::${name}`, callback)
  }

  get(key) {
    const object = this.getSettingObject(key)
    return object.getSetting(key)
  }
}
