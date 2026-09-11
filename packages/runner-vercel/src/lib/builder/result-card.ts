import { Actions, Button, Card, CardText, LinkButton, type CardElement } from "chat";
import { builderResultPresentation, type BuilderCardModel } from "../../../../runtime/builder/presentation.ts";
export function renderBuilderCard(model: BuilderCardModel): CardElement {
  return Card({ title: model.title, children: [...model.paragraphs.map(text => CardText(text)),
    ...(model.actions.length ? [Actions(model.actions.map(action => action.url
      ? LinkButton({ label: action.label, url: action.url, style: action.style })
      : Button({ id: action.id, label: action.label, value: action.value, style: action.style })))] : [])] });
}
export function builderResultCard(...args: Parameters<typeof builderResultPresentation>): CardElement {
  return renderBuilderCard(builderResultPresentation(...args));
}
