import React from 'react';
import createReactClass from 'create-react-class';
import AsyncValidator from 'async-validator';
import warning from 'warning';
import get from 'lodash/get';
import set from 'lodash/set';
import createFieldsStore from './createFieldsStore';
import {
  argumentContainer,
  identity,
  normalizeValidateRules,
  getValidateTriggers,
  getValueFromEvent,
  hasRules,
  getParams,
  isEmptyObject,
  flattenArray,
} from './utils';

const DEFAULT_TRIGGER = 'onChange';

function createBaseForm(option = {}, mixins = []) {
  const {
    validateMessages,
    onFieldsChange,
    onValuesChange, // onValuesChange(this.props, changedValues, allValues);
    mapProps = identity,
    mapPropsToFields,
    fieldNameProp,
    fieldMetaProp, // meta prop name to be bind onto input props
    fieldDataProp, // data props, to be binded onto input props
    formPropName = 'form',
    // @deprecated
    withRef,
  } = option;

  return function decorate(WrappedComponent) {
    const Form = createReactClass({
      mixins,

      getInitialState() {
        const fields = mapPropsToFields && mapPropsToFields(this.props);
        this.fieldsStore = createFieldsStore(fields || {});

        this.instances = {};
        this.cachedBind = {};
        this.clearedFieldMetaCache = {};

        // delegate methods call to this.fieldStore
        // HACK: https://github.com/ant-design/ant-design/issues/6406
        ['getFieldsValue',
         'getFieldValue',
         'setFieldsInitialValue',
         'getFieldsError',
         'getFieldError',
         'isFieldValidating',
         'isFieldsValidating',
         'isFieldsTouched',
         'isFieldTouched'].forEach(key => this[key] = (...args) => {
           if (process.env.NODE_ENV !== 'production') {
             warning(
               false,
               'you should not use `ref` on enhanced form, please use `wrappedComponentRef`. ' +
                 'See: https://github.com/react-component/form#note-use-wrappedcomponentref-instead-of-withref-after-rc-form140'
             );
           }
           return this.fieldsStore[key](...args);
         });

        return {
          submitting: false,
        };
      },

      componentWillReceiveProps(nextProps) {
        if (mapPropsToFields) {
          this.fieldsStore.updateFields(mapPropsToFields(nextProps));
        }
      },

      onCollectCommon(name, action, args) {
        const fieldMeta = this.fieldsStore.getFieldMeta(name);
        // invoke action on fieldMeta or fieldsMeta.originalProps
        if (fieldMeta[action]) {
          fieldMeta[action](...args);
        } else if (fieldMeta.originalProps && fieldMeta.originalProps[action]) {
          fieldMeta.originalProps[action](...args);
        }
        // fieldMeta.getValueFromEvent(...args) or return event(=args) 's target value|checked status
        const value = fieldMeta.getValueFromEvent ?
          fieldMeta.getValueFromEvent(...args) :
          getValueFromEvent(...args);
        if (onValuesChange && value !== this.fieldsStore.getFieldValue(name)) { // trigger onValuesChange event
          const valuesAll = this.fieldsStore.getAllValues();
          const valuesAllSet = {};
          valuesAll[name] = value;
          Object.keys(valuesAll).forEach(key => set(valuesAllSet, key, valuesAll[key]));
          onValuesChange(this.props, set({}, name, value), valuesAllSet); // trigger change
        }
        const field = this.fieldsStore.getField(name); // sync this.fieldStore.fields
        return ({ name, field: { ...field, value, touched: true }, fieldMeta });
      },

      onCollect(name_, action, ...args) {
        const { name, field, fieldMeta } = this.onCollectCommon(name_, action, args);
        const { validate } = fieldMeta;
        const newField = {
          ...field,
          dirty: hasRules(validate), // :todo, dirty is used for what ?
        };
        this.setFields({
          [name]: newField,
        });
      },

      onCollectValidate(name_, action, ...args) {
        const { field, fieldMeta } = this.onCollectCommon(name_, action, args);
        const newField = {
          ...field,
          dirty: true,
        };
        // so here it just run validation methods, trigger no callback 
        this.validateFieldsInternal([newField], {
          action,
          options: {
            firstFields: !!fieldMeta.validateFirst,
          },
        });
      },


      // name, prop name
      // fn(name, action, )-> ()
      // return {[action]: fn}
      getCacheBind(name, action, fn) {
        if (!this.cachedBind[name]) {
          this.cachedBind[name] = {};
        }
        const cache = this.cachedBind[name];
        if (!cache[action]) {
          cache[action] = fn.bind(this, name, action);
        }
        return cache[action];
      },

      // recovery field data & delete recoveried data
      recoverClearedField(name) {
        if (this.clearedFieldMetaCache[name]) {
          this.fieldsStore.setFields({
            [name]: this.clearedFieldMetaCache[name].field,
          });
          this.fieldsStore.setFieldMeta(name, this.clearedFieldMetaCache[name].meta);
          delete this.clearedFieldMetaCache[name];
        }
      },

      getFieldDecorator(name, fieldOption) {
        const props = this.getFieldProps(name, fieldOption);
        return (fieldElem) => {
          const fieldMeta = this.fieldsStore.getFieldMeta(name);
          const originalProps = fieldElem.props;
          if (process.env.NODE_ENV !== 'production') {
            const valuePropName = fieldMeta.valuePropName;
            warning(
              !(valuePropName in originalProps),
              `\`getFieldDecorator\` will override \`${valuePropName}\`, ` +
              `so please don't set \`${valuePropName}\` directly ` +
              `and use \`setFieldsValue\` to set it.`
            );
            const defaultValuePropName =
              `default${valuePropName[0].toUpperCase()}${valuePropName.slice(1)}`;
            warning(
              !(defaultValuePropName in originalProps),
              `\`${defaultValuePropName}\` is invalid ` +
              `for \`getFieldDecorator\` will set \`${valuePropName}\`,` +
              ` please use \`option.initialValue\` instead.`
            );
          }
          fieldMeta.originalProps = originalProps;
          fieldMeta.ref = fieldElem.ref;
          return React.cloneElement(fieldElem, {
            ...props,
            ...this.fieldsStore.getFieldValuePropValue(fieldMeta),
          });
        };
      },

      /**
       * 
       * @param {string} name , field name
       * @param {object} usersFieldOption, meta props
       */
      getFieldProps(name, usersFieldOption = {}) {
        if (!name) {
          throw new Error('Must call `getFieldProps` with valid name string!');
        }
        if (process.env.NODE_ENV !== 'production') {
          warning(
            this.fieldsStore.isValidNestedFieldName(name),
            'One field name cannot be part of another, e.g. `a` and `a.b`.'
          );
          warning(
            !('exclusive' in usersFieldOption),
            '`option.exclusive` of `getFieldProps`|`getFieldDecorator` had been remove.'
          );
        }

        delete this.clearedFieldMetaCache[name];

        const fieldOption = {
          name,
          trigger: DEFAULT_TRIGGER, // onchage
          valuePropName: 'value',
          validate: [],
          ...usersFieldOption,
        };

        const {
          rules,
          trigger,
          validateTrigger = trigger,
          validate,
        } = fieldOption;

        const fieldMeta = this.fieldsStore.getFieldMeta(name);
        if ('initialValue' in fieldOption) { // override initialValue here ?
          fieldMeta.initialValue = fieldOption.initialValue;
        }

        const inputProps = {
          ...this.fieldsStore.getFieldValuePropValue(fieldOption),
          // after binding, saveRef becomes type with (component)-> void
          ref: this.getCacheBind(name, `${name}__ref`, this.saveRef),
        };
        if (fieldNameProp) {
          inputProps[fieldNameProp] = name;
        }

        const validateRules = normalizeValidateRules(validate, rules, validateTrigger);
        const validateTriggers = getValidateTriggers(validateRules);
        validateTriggers.forEach((action) => {
          if (inputProps[action]) return;
          inputProps[action] = this.getCacheBind(name, action, this.onCollectValidate);
        });

        // make sure that the value will be collect
        if (trigger && validateTriggers.indexOf(trigger) === -1) {
          inputProps[trigger] = this.getCacheBind(name, trigger, this.onCollect);
        }

        const meta = {
          ...fieldMeta,
          ...fieldOption,
          validate: validateRules,
        };
        this.fieldsStore.setFieldMeta(name, meta);
        if (fieldMetaProp) {
          inputProps[fieldMetaProp] = meta;
        }

        if (fieldDataProp) {
          inputProps[fieldDataProp] = this.fieldsStore.getField(name);
        }

        return inputProps;
      },

      getFieldInstance(name) {
        return this.instances[name];
      },

      /**
       * return all fieldMeta validation rules or the ones contains target action
       * @param {validate: {rules: [], trigger: string[]}} fieldMeta 
       * @param {*} action 
       */
      getRules(fieldMeta, action) {
        const actionRules = fieldMeta.validate.filter((item) => {
          return !action || item.trigger.indexOf(action) >= 0;
        }).map((item) => item.rules);
        return flattenArray(actionRules); // return rules as one demension array
      },
      
      // set changed fields & trigger callback after view is updated 
      setFields(maybeNestedFields, callback) {
        const fields = this.fieldsStore.flattenRegisteredFields(maybeNestedFields);
        this.fieldsStore.setFields(fields); // override change fields
        if (onFieldsChange) {
          const changedFields = Object.keys(fields)
            .reduce((acc, name) => set(acc, name, this.fieldsStore.getField(name)), {});
          onFieldsChange(this.props, changedFields, this.fieldsStore.getNestedAllFields());
        }
        this.forceUpdate(callback); // :bm, this is not cool, man!
      },

      // reset fields value
      resetFields(ns) {
        const newFields = this.fieldsStore.resetFields(ns);
        if (Object.keys(newFields).length > 0) {
          this.setFields(newFields);
        }
        if (ns) {
          const names = Array.isArray(ns) ? ns : [ns];
          names.forEach(name => delete this.clearedFieldMetaCache[name]);
        } else {
          this.clearedFieldMetaCache = {};
        }
      },

      // set fields value
      setFieldsValue(changedValues, callback) {
        const { fieldsMeta } = this.fieldsStore;
        const values = this.fieldsStore.flattenRegisteredFields(changedValues);
        const newFields = Object.keys(values).reduce((acc, name) => {
          const isRegistered = fieldsMeta[name];
          if (process.env.NODE_ENV !== 'production') {
            warning(
              isRegistered,
              'Cannot use `setFieldsValue` until ' +
                'you use `getFieldDecorator` or `getFieldProps` to register it.'
            );
          }
          if (isRegistered) {
            const value = values[name];
            acc[name] = {
              value,
            };
          }
          return acc;
        }, {});
        this.setFields(newFields, callback);
        if (nValuesChange) {
          const allValues = this.fieldsStore.getAllValues();
          onValuesChange(this.props, changedValues, allValues);
        }
      },

      saveRef(name, _, component) {
        // so, if component is absent we preseve its value into clearedFieldMetaCache 
        // so we can bind them back when the component is added back again
        if (!component) { 
          // after destroy, delete data
          this.clearedFieldMetaCache[name] = {
            field: this.fieldsStore.getField(name),
            meta: this.fieldsStore.getFieldMeta(name),
          };
          this.fieldsStore.clearField(name);
          delete this.instances[name]; // name -> actual form item component
          delete this.cachedBind[name];
          return;
        }
        this.recoverClearedField(name);
        const fieldMeta = this.fieldsStore.getFieldMeta(name);
        if (fieldMeta) {
          const ref = fieldMeta.ref; // (component)->void
          if (ref) {
            if (typeof ref === 'string') {
              throw new Error(`can not set ref string for ${name}`);
            }
            ref(component);
          }
        }
        this.instances[name] = component;
      },

      validateFieldsInternal(fields, {
        fieldNames,
        action,
        options = {},
      }, callback) { // (errors: [], fieldValues: any)=>()
        const allRules = {};
        const allValues = {};
        const allFields = {};
        const alreadyErrors = {};
        fields.forEach((field) => {
          const name = field.name;
          if (options.force !== true && field.dirty === false) { // if not dirty & force, reset errors and return 
            if (field.errors) {
              set(alreadyErrors, name, { errors: field.errors });
            }
            return;
          }
          const fieldMeta = this.fieldsStore.getFieldMeta(name);
          const newField = {
            ...field,
          };
          newField.errors = undefined;
          newField.validating = true;
          newField.dirty = true;
          allRules[name] = this.getRules(fieldMeta, action);
          allValues[name] = newField.value;
          allFields[name] = newField;
        });
        this.setFields(allFields);
        // in case normalize
        Object.keys(allValues).forEach((f) => {
          allValues[f] = this.fieldsStore.getFieldValue(f);
        });
        if (callback && isEmptyObject(allFields)) { // validating is not trggered, used last result, so callback is called with changes
          callback(isEmptyObject(alreadyErrors) ? null : alreadyErrors,
            this.fieldsStore.getFieldsValue(fieldNames));
          return;
        }
        const validator = new AsyncValidator(allRules);
        if (validateMessages) {
          validator.messages(validateMessages); // :?
        }
        validator.validate(allValues, options, (errors) => {
          const errorsGroup = {
            ...alreadyErrors,
          };
          if (errors && errors.length) {
            errors.forEach((e) => {
              const fieldName = e.field;
              const field = get(errorsGroup, fieldName);
              // wtf here assert that field is array ? type field != object should be enough
              if (typeof field !== 'object' || Array.isArray(field)) { // push each error into respect error fields 
                set(errorsGroup, fieldName, { errors: [] });
              }
              const fieldErrors = get(errorsGroup, fieldName.concat('.errors'));
              fieldErrors.push(e);
            });
          }
          const expired = [];
          const nowAllFields = {};
          Object.keys(allRules).forEach((name) => { // name is each rule, 
            const fieldErrors = get(errorsGroup, name);
            const nowField = this.fieldsStore.getField(name);
            // avoid concurrency problems
            if (nowField.value !== allValues[name]) {
              expired.push({
                name,
              });
            } else {
              nowField.errors = fieldErrors && fieldErrors.errors;
              nowField.value = allValues[name];
              nowField.validating = false;
              nowField.dirty = false;
              nowAllFields[name] = nowField;
            }
          });
          this.setFields(nowAllFields); // update view again
          if (callback) {
            if (expired.length) {
              expired.forEach(({ name }) => {
                const fieldErrors = [{
                  message: `${name} need to revalidate`,
                  field: name,
                }];
                set(errorsGroup, name, {
                  expired: true,
                  errors: fieldErrors,
                });
              });
            }

            callback(isEmptyObject(errorsGroup) ? null : errorsGroup,
              this.fieldsStore.getFieldsValue(fieldNames));
          }
        });
      },

      /**
       * validate all form fields, or some selected ones 
       * @param {*} ns 
       * @param {*} opt 
       * @param {*} cb 
       */
      validateFields(ns, opt, cb) {
        const { names, callback, options } = getParams(ns, opt, cb);
        const fieldNames = names ?
          this.fieldsStore.getValidFieldsFullName(names) :
          this.fieldsStore.getValidFieldsName();
        const fields = fieldNames
          .filter(name => {
            const fieldMeta = this.fieldsStore.getFieldMeta(name);
            return hasRules(fieldMeta.validate);
          }).map((name) => {
            const field = this.fieldsStore.getField(name);
            field.value = this.fieldsStore.getFieldValue(name);
            return field;
          });
        if (!fields.length) {
          if (callback) {
            callback(null, this.fieldsStore.getFieldsValue(fieldNames));
          }
          return;
        }
        if (!('firstFields' in options)) {
          options.firstFields = fieldNames.filter((name) => {
            const fieldMeta = this.fieldsStore.getFieldMeta(name);
            return !!fieldMeta.validateFirst;
          });
        }
        this.validateFieldsInternal(fields, {
          fieldNames,
          options,
        }, callback);
      },

      isSubmitting() {
        if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
          warning(
            false,
            '`isSubmitting` is deprecated. ' +
              'Actually, it\'s more convenient to handle submitting status by yourself.'
          );
        }
        return this.state.submitting;
      },

      submit(callback) {
        if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
          warning(
            false,
            '`submit` is deprecated.' +
              'Actually, it\'s more convenient to handle submitting status by yourself.'
          );
        }
        const fn = () => {
          this.setState({
            submitting: false,
          });
        };
        this.setState({
          submitting: true,
        });
        callback(fn);
      },

      render() {
        const { wrappedComponentRef, ...restProps } = this.props;
        const formProps = {
          [formPropName]: this.getForm(),
        };
        if (withRef) {
          if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
            warning(
              false,
              '`withRef` is deprecated, please use `wrappedComponentRef` instead. ' +
                'See: https://github.com/react-component/form#note-use-wrappedcomponentref-instead-of-withref-after-rc-form140'
            );
          }
          formProps.ref = 'wrappedComponent';
        } else if (wrappedComponentRef) {
          formProps.ref = wrappedComponentRef;
        }
        const props = mapProps.call(this, {
          ...formProps,
          ...restProps,
        });
        return <WrappedComponent {...props}/>;
      },
    });

    return argumentContainer(Form, WrappedComponent); // copy displayName & static properties
  };
}

export default createBaseForm;
