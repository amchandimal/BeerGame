import { Component, EventEmitter, Input, Output } from '@angular/core';

export interface CardOption<T> { value: T; label: string; description?: string; }
// A radio group drawn as cards (information visibility, classroom participation and demand scenario). The host element is the fieldset.
@Component({
  selector: 'fieldset[appCardPicker]', standalone: true, host: { class: 'visibility-picker' },
  template: `<legend>{{legend}}</legend><div class="visibility-cards">@for (option of options; track option.value) {<label class="visibility-card" [class.current]="value === option.value"><input type="radio" [name]="name" [checked]="value === option.value" (change)="valueChange.emit(option.value)"><span class="visibility-card-title">{{option.label}}</span>@if (option.description) {<span class="visibility-card-description">{{option.description}}</span>}</label>}</div>`
})
export class CardPickerComponent<T> {
  @Input({ required: true }) legend = '';
  @Input({ required: true }) name = '';
  @Input({ required: true }) options: readonly CardOption<T>[] = [];
  @Input({ required: true }) value!: T;
  @Output() valueChange = new EventEmitter<T>();
}
