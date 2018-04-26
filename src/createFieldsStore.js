import set from 'lodash/set';
import createFormField, { isFormField } from './createFormField';
import {
  flattenFields,
  getErrorStrs,
  startsWith,
} from './utils';

// b = `a[` or `a.`
function partOf(a, b) {
  return b.indexOf(a) === 0 && ['.', '['].indexOf(b[a.length]) !== -1;
}

class FieldsStore {
  constructor(fields) {
    this.fields = this.flattenFields(fields);
    this.fieldsMeta = {};
  }

  updateFields(fields) {
    this.fields = this.flattenFields(fields);
  }

  // flatten form fields & return 
  flattenFields(fields) {
    return flattenFields(
      fields,
      (_, node) => isFormField(node),
      'You must wrap field data with `createFormField`.'
    );
  }

  // return a flattened obj that register in `this.getAllFieldsName`
  flattenRegisteredFields(fields) {
    const validFieldsName = this.getAllFieldsName();
    return flattenFields(
      fields,
      path => validFieldsName.indexOf(path) >= 0,
      'You cannot set field before registering it.'
    );
  }

  setFieldsInitialValue = (initialValues) => {
    const flattenedInitialValues = this.flattenRegisteredFields(initialValues);
    const fieldsMeta = this.fieldsMeta;
    Object.keys(flattenedInitialValues).forEach(name => {
      if (fieldsMeta[name]) {
        this.setFieldMeta(name, {
          ...this.getFieldMeta(name),
          initialValue: flattenedInitialValues[name],
        });
      }
    });
  }

  // update form fields values, & run `normalize` on each field's value
  setFields(fields) {
    const fieldsMeta = this.fieldsMeta;
    const nowFields = {
      ...this.fields,
      ...fields,
    };
    const nowValues = {};
    Object.keys(fieldsMeta)
      .forEach((f) => nowValues[f] = this.getValueFromFields(f, nowFields));
    Object.keys(nowValues).forEach((f) => {
      const value = nowValues[f];
      const fieldMeta = this.getFieldMeta(f);
      if (fieldMeta && fieldMeta.normalize) {
        const nowValue =
                fieldMeta.normalize(value, this.getValueFromFields(f, this.fields), nowValues);
        if (nowValue !== value) {
          nowFields[f] = {
            ...nowFields[f],
            value: nowValue,
          };
        }
      }
    });
    this.fields = nowFields;
  }

  // get default obj with shape of `{names: {}}`
  resetFields(ns) {
    const { fields } = this;
    const names = ns ?
      this.getValidFieldsFullName(ns) :
      this.getAllFieldsName();
    return names.reduce((acc, name) => {
      const field = fields[name];
      if (field && 'value' in field) {
        acc[name] = {};
      }
      return acc;
    }, {});
  }

  setFieldMeta(name, meta) {
    this.fieldsMeta[name] = meta;
  }

  // get field meta
  getFieldMeta(name) {
    this.fieldsMeta[name] = this.fieldsMeta[name] || {};
    return this.fieldsMeta[name];
  }

  // get value & initialValue from name field
  getValueFromFields(name, fields) {
    const field = fields[name];
    if (field && 'value' in field) {
      return field.value;
    }
    const fieldMeta = this.getFieldMeta(name);
    return fieldMeta && fieldMeta.initialValue;
  }

  // collect all fields value
  getAllValues = () => {
    const { fieldsMeta, fields } = this;
    return Object.keys(fieldsMeta)
      .reduce((acc, name) => set(acc, name, this.getValueFromFields(name, fields)), {});
  }

  // return non hiden keys in meta
  getValidFieldsName() {
    const { fieldsMeta } = this;
    return fieldsMeta ?
      Object.keys(fieldsMeta).filter(name => !this.getFieldMeta(name).hidden) :
      [];
  }

  getAllFieldsName() {
    const { fieldsMeta } = this;
    return fieldsMeta ? Object.keys(fieldsMeta) : [];
  }

  // get full name array that contains maybePartialName
  getValidFieldsFullName(maybePartialName) {
    const maybePartialNames = Array.isArray(maybePartialName) ?
      maybePartialName : [maybePartialName];
    // fullName is shape like `a.b.c` or `a[b[c`?
    return this.getValidFieldsName()
      .filter(fullName => maybePartialNames.some(partialName => (
        fullName === partialName || (
          startsWith(fullName, partialName) &&
          ['.', '['].indexOf(fullName[partialName.length]) >= 0
        )
      )));
  }
  /**
   * 
   * @param {*} fieldMeta 
   *  - getValueProps: (value)-> any
   *  - valuePropName: string
   * 
   * @return {[valuePropName]: value}
   */
  getFieldValuePropValue(fieldMeta) {
    const { name, getValueProps, valuePropName } = fieldMeta;
    const field = this.getField(name);
    const fieldValue = 'value' in field ?
      field.value : fieldMeta.initialValue;
    if (getValueProps) {
      return getValueProps(fieldValue);
    }
    return { [valuePropName]: fieldValue };
  }

  getField(name) {
    return {
      ...this.fields[name],
      name,
    };
  }

  getNotCollectedFields() {
    return this.getValidFieldsName()
      .filter(name => !this.fields[name])
      .map(name => ({
        name,
        dirty: false,
        value: this.getFieldMeta(name).initialValue,
      }))
      .reduce((acc, field) => set(acc, field.name, createFormField(field)), {});
  }

  getNestedAllFields() {
    return Object.keys(this.fields)
      .reduce(
        (acc, name) => set(acc, name, createFormField(this.fields[name])),
        this.getNotCollectedFields()
      );
  }

  getFieldMember(name, member) {
    return this.getField(name)[member];
  }

  getNestedFields(names, getter) {
    const fields = names || this.getValidFieldsName();
    return fields.reduce((acc, f) => set(acc, f, getter(f)), {});
  }

  // name, if name if fullpath return getter(name)
  // or collect all fullNames' nested values that start with name
  getNestedField(name, getter) {
    const fullNames = this.getValidFieldsFullName(name);
    if (
      fullNames.length === 0 || // Not registered
        (fullNames.length === 1 && fullNames[0] === name) // Name already is full name.
    ) {
      return getter(name);
    }
    const isArrayValue = fullNames[0][name.length] === '[';
    const suffixNameStartIndex = isArrayValue ? name.length : name.length + 1;
    return fullNames
      .reduce(
        (acc, fullName) => set(
          acc,
          fullName.slice(suffixNameStartIndex),
          getter(fullName)
        ),
        isArrayValue ? [] : {}
      );
  }

  // get list of all value of all field that starts with array of name path 
  getFieldsValue = (names) => {
    return this.getNestedFields(names, this.getFieldValue);
  }

  // get all value of all fields that start with name path
  getFieldValue = (name) => {
    const { fields } = this;
    return this.getNestedField(name, (fullName) => this.getValueFromFields(fullName, fields));
  }

  // get all names fields' error attributes
  getFieldsError = (names) => {
    return this.getNestedFields(names, this.getFieldError);
  }

  // get errors that nested in field that start with name path
  getFieldError = (name) => {
    return this.getNestedField(
      name,
      (fullName) => getErrorStrs(this.getFieldMember(fullName, 'errors'))
    );
  }

  // is name field been validating1
  isFieldValidating = (name) => {
    return this.getFieldMember(name, 'validating');
  }

  // is any names or validFieldsName been validating
  isFieldsValidating = (ns) => {
    const names = ns || this.getValidFieldsName();
    return names.some((n) => this.isFieldValidating(n));
  }

  // is target name field been touched
  isFieldTouched = (name) => {
    return this.getFieldMember(name, 'touched');
  }

  // is any field been touched
  isFieldsTouched = (ns) => {
    const names = ns || this.getValidFieldsName();
    return names.some((n) => this.isFieldTouched(n));
  }

  // @private
  // BG: `a` and `a.b` cannot be use in the same form
  isValidNestedFieldName(name) {
    const names = this.getAllFieldsName();
    return names.every(n => !partOf(n, name) && !partOf(name, n));
  }

  // well clean datas
  clearField(name) {
    delete this.fields[name];
    delete this.fieldsMeta[name];
  }
}

export default function createFieldsStore(fields) {
  return new FieldsStore(fields);
}
