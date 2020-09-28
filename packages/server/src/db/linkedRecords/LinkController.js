const CouchDB = require("../index")
const linkedRecords = require("./index")

/**
 * Creates a new link document structure which can be put to the database. It is important to
 * note that while this talks about linker/linked the link is bi-directional and for all intent
 * and purposes it does not matter from which direction the link was initiated.
 * @param {string} modelId1 The ID of the first model (the linker).
 * @param {string} modelId2 The ID of the second model (the linked).
 * @param {string} fieldName1 The name of the field in the linker table.
 * @param {string} fieldName2 The name of the field in the linked table.
 * @param {string} recordId1 The ID of the record which is acting as the linker.
 * @param {string} recordId2 The ID of the record which is acting as the linked.
 * @constructor
 */
function LinkDocument(
  modelId1,
  fieldName1,
  recordId1,
  modelId2,
  fieldName2,
  recordId2
) {
  this.doc1 = {
    modelId: modelId1,
    fieldName: fieldName1,
    recordId: recordId1,
  }
  this.doc2 = {
    modelId: modelId2,
    fieldName: fieldName2,
    recordId: recordId2,
  }
}

class LinkController {
  /**
   * Create a new link controller which can be used to handle link updates for an event.
   * @param {string} instanceId The instance in which updates will be carried out.
   * @param {{modelId: string, model: object|undefined, record: object|undefined}} eventData data about
   * what has occurred to drive this update - events are emitted when an operation that matters occurs.
   */
  constructor(instanceId, eventData) {
    this._instanceId = instanceId
    this._db = new CouchDB(instanceId)
    this._modelId = eventData.modelId
    this._record = eventData.record
    this._model = eventData.model
  }

  /**
   * Retrieves the model, if it was not already found in the eventData.
   * @returns {Promise<object>} This will return a model based on the event data, either
   * if it was in the event already, or it uses the specified modelId to get it.
   */
  async model() {
    if (this._model == null) {
      this._model =
        this._model == null ? await this._db.get(this._modelId) : this._model
    }
    return this._model
  }

  /**
   * Checks if the model this was constructed with has any linking columns currently.
   * If the model has not been retrieved this will retrieve it based on the eventData.
   * @returns {Promise<boolean>} True if there are any linked fields, otherwise it will return
   * false.
   */
  async doesModelHaveLinkedFields() {
    const model = await this.model()
    for (const fieldName of Object.keys(model.schema)) {
      const { type } = model.schema[fieldName]
      if (type === "link") {
        return true
      }
    }
    return false
  }

  /**
   * Utility function for main getLinkDocuments function - refer to it for functionality.
   */
  getLinkDocs(fieldName, recordId) {
    return linkedRecords.getLinkDocuments({
      instanceId: this._instanceId,
      modelId: this._modelId,
      fieldName,
      recordId,
    })
  }

  // all operations here will assume that the model
  // this operation is related to has linked records
  /**
   * When a record is saved this will carry out the necessary operations to make sure
   * the link has been created/updated.
   * @returns {Promise<null>} The operation has been completed and the link documents should now
   * be accurate.
   */
  async recordSaved() {
    const model = await this.model()
    const record = this._record
    let operations = []
    for (let fieldName of Object.keys(model.schema)) {
      const field = model.schema[fieldName]
      if (field.type === "link") {
        // get link docs to compare against
        let currentLinkIds = await this.getLinkDocs(fieldName, record._id).map(
          doc => doc._id
        )
        let toLinkIds = record[fieldName]
        for (let linkId of toLinkIds) {
          if (currentLinkIds.indexOf(linkId) === -1) {
            operations.push(
              new LinkDocument(
                model._id,
                fieldName,
                record._id,
                field.modelId,
                field.fieldName,
                linkId
              )
            )
          }
          const toDeleteIds = currentLinkIds.filter(
            id => toLinkIds.indexOf(id) === -1
          )
          operations.concat(
            toDeleteIds.map(id => ({ _id: id, _deleted: true }))
          )
        }
      }
    }
    await this._db.bulkDocs(operations)
  }

  /**
   * When a record is deleted this will carry out the necessary operations to make sure
   * any links that existed have been removed.
   * @returns {Promise<null>} The operation has been completed and the link documents should now
   * be accurate.
   */
  async recordDeleted() {
    const record = this._record
    // get link docs to compare against
    let toDelete = await this.getLinkDocs(null, record._id).map(doc => {
      return {
        ...doc,
        _deleted: true,
      }
    })
    await this._db.bulkDocs(toDelete)
  }

  /**
   * When a model is saved this will carry out the necessary operations to make sure
   * any linked models are notified and updated correctly.
   * @returns {Promise<null>} The operation has been completed and the link documents should now
   * be accurate.
   */
  async modelSaved() {
    const model = await this.model()
    const schema = model.schema
    for (const fieldName of Object.keys(schema)) {
      const field = schema[fieldName]
      if (field.type === "link") {
        // create the link field in the other model
        const linkedModel = await this._db.get(field.modelId)
        linkedModel.schema[field.fieldName] = {
          name: model.name,
          type: "link",
          modelId: model._id,
          fieldName: fieldName,
        }
        await this._db.put(linkedModel)
      }
    }
  }

  /**
   * When a model is deleted this will carry out the necessary operations to make sure
   * any linked models have the joining column correctly removed as well as removing any
   * now stale linking documents.
   * @returns {Promise<null>} The operation has been completed and the link documents should now
   * be accurate.
   */
  async modelDeleted() {
    const model = await this.model()
    const schema = model.schema
    for (const fieldName of Object.keys(schema)) {
      let field = schema[fieldName]
      if (field.type === "link") {
        const linkedModel = await this._db.get(field.modelId)
        delete linkedModel.schema[model.name]
        await this._db.put(linkedModel)
      }
    }
    // get link docs for this model and configure for deletion
    let toDelete = await this.getLinkDocs().map(doc => {
      return {
        ...doc,
        _deleted: true,
      }
    })
    await this._db.bulkDocs(toDelete)
  }
}

module.exports = LinkController
